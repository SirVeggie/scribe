//! Scribe desktop: a native window over the same daemon and UI the browser uses.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod board;
mod docking;
mod downloads;
#[cfg(windows)]
mod drops;
#[cfg(windows)]
mod embeds;
#[cfg(windows)]
mod keys;
mod layout;
mod startup;
mod tray;

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const MAIN: &str = "main";
/// Labels of the windows that show one page on their own (public/popout.js).
pub(crate) const CHILD_PREFIX: &str = "child-";
const CHILD_SIZE: (f64, f64) = (960.0, 720.0);

/// Why the daemon last failed to start, for the offline page.
#[derive(Default)]
struct DaemonError(Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    board: String,
    running: bool,
    error: Option<String>,
}

#[tauri::command]
async fn desktop_state(window: WebviewWindow) -> layout::DesktopState {
    layout::desktop_state(&window)
}

#[tauri::command]
async fn window_action(window: WebviewWindow, action: String) -> Result<(), String> {
    let result = match action.as_str() {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "drag-child" => {
            docking::watch(&window);
            window.start_dragging()
        }
        "toggle-compact" => {
            layout::toggle_compact(&window);
            Ok(())
        }
        // The board page lost the daemon. Swap it for the offline page, which comes back when it can.
        "daemon-offline" => {
            if board::is_running() {
                return Ok(());
            }
            let mut url = offline_url();
            url.set_fragment(window.url().ok().as_ref().and_then(Url::fragment));
            window.navigate(url)
        }
        _ => return Err(format!("Unknown window action: {action}")),
    };
    result.map_err(|err| err.to_string())
}

/// The shell reports whether focus is in an embedded site, which gets the board's shortcuts natively.
#[tauri::command]
fn key_focus(window: WebviewWindow, embed: bool) {
    #[cfg(windows)]
    keys::set_embed_focus(window.label(), embed);
    #[cfg(not(windows))]
    let _ = (window, embed);
}

#[tauri::command]
async fn set_desktop_setting(
    window: WebviewWindow,
    name: String,
    value: bool,
) -> Result<layout::DesktopState, String> {
    match name.as_str() {
        "compactOnTop" => layout::set_compact_on_top(&window, value),
        "openFromAgents" => board::write_registration(value),
        "closeToTray" => {
            layout::set_close_to_tray(&window, value);
            tray::set_enabled(window.app_handle(), value);
        }
        "launchAtStartup" => startup::set_enabled(value)?,
        "reducedMotion" => layout::set_reduced_motion(&window, value),
        "dockChildWindows" => layout::set_dock_child_windows(&window, value),
        _ => return Err(format!("Unknown desktop setting: {name}")),
    }
    Ok(layout::desktop_state(&window))
}

/// A page in a window of its own: `open` it (or bring it forward when it is open), `focus` it, or
/// `focus-main` to bring the main window forward from one.
#[tauri::command]
async fn child_window(
    app: AppHandle,
    action: String,
    id: String,
    title: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    match action.as_str() {
        "open" => open_child(&app, &id, title.as_deref().unwrap_or("Scribe"), x.zip(y)).map_err(|err| err.to_string()),
        "focus" => {
            if let Some(window) = app.get_webview_window(&child_label(&id)) {
                raise(&window);
            }
            Ok(())
        }
        "focus-main" => {
            if let Some(window) = app.get_webview_window(MAIN) {
                focus(&window);
            }
            Ok(())
        }
        _ => Err(format!("Unknown child window action: {action}")),
    }
}

/// Keep in sync with labelOf in public/popout.js.
fn child_label(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect();
    format!("{CHILD_PREFIX}{safe}")
}

fn raise(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// The board again, told to show one page: its own title bar, no tab strip, at `at` on screen.
fn open_child(app: &AppHandle, id: &str, title: &str, at: Option<(f64, f64)>) -> Result<(), Box<dyn std::error::Error>> {
    let label = child_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        raise(&window);
        return Ok(());
    }
    let mut url: Url = format!("{}/", board::base_url()).parse()?;
    url.query_pairs_mut().append_pair("popout", id);
    let board_origin = url.origin();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .zoom_hotkeys_enabled(true)
        .disable_drag_drop_handler()
        .on_download(downloads::handle)
        .inner_size(CHILD_SIZE.0, CHILD_SIZE.1)
        .min_inner_size(320.0, 240.0)
        .decorations(true)
        .on_new_window(|url, _| {
            board::open_external(url.as_str());
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if url.origin() == board_origin {
                return true;
            }
            board::open_external(url.as_str());
            false
        });
    if let Some((x, y)) = at {
        builder = builder.position(x, y);
    }
    let window = builder.build()?;
    // Stripped after the build for the same reason as the main window's.
    window.set_decorations(false)?;
    #[cfg(windows)]
    {
        keys::install(&window);
        embeds::install(&window, board::port());
        drops::install(&window);
    }
    Ok(())
}

/// For the offline page: whether the daemon answers, optionally after trying to start it.
#[tauri::command]
async fn daemon_status(app: AppHandle, start: bool) -> DaemonStatus {
    let last_error = app.state::<DaemonError>();
    if start {
        let result = tauri::async_runtime::spawn_blocking(board::ensure_daemon)
            .await
            .unwrap_or_else(|err| Err(err.to_string()));
        *last_error.0.lock().unwrap() = result.err();
    }
    let error = last_error.0.lock().unwrap().clone();
    DaemonStatus {
        board: format!("{}/", board::base_url()),
        running: board::is_running(),
        error,
    }
}

/// The bundled page (splash/index.html) shown while the daemon is down, where Tauri serves it.
fn offline_url() -> Url {
    let origin = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
    format!("{origin}/index.html").parse().expect("valid offline page URL")
}

/// Show the window, from the taskbar, the tray, or nowhere yet.
fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    layout::push_state(window);
}

fn select_tab(window: &WebviewWindow, tab: &str) {
    let _ = window.eval(format!("location.hash = {tab:?}"));
}

fn quit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        layout::remember(&window);
    }
    app.exit(0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN) {
                focus(&window);
                if let Some(tab) = board::tab_from_args(&argv) {
                    select_tab(&window, &tab);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            window_action,
            set_desktop_setting,
            daemon_status,
            child_window,
            key_focus
        ])
        .on_window_event(layout::on_window_event)
        .setup(move |app| {
            let daemon_error = board::ensure_daemon().err();
            let daemon_up = daemon_error.is_none();
            app.manage(DaemonError(Mutex::new(daemon_error)));
            let open_from_agents = board::read_registration().is_none_or(|registration| registration.open_from_agents);
            board::write_registration(open_from_agents);

            let base = board::base_url();
            // Only the board's own origin gets IPC. Tab pages (each on its own *.localhost origin) and embedded sites do not.
            app.add_capability(
                CapabilityBuilder::new("scribe")
                    .remote(format!("{base}/*"))
                    .window(MAIN)
                    .window(format!("{CHILD_PREFIX}*"))
                    .permission("core:window:allow-start-dragging")
                    .permission("core:window:allow-internal-toggle-maximize")
                    .permission("allow-desktop-state")
                    .permission("allow-window-action")
                    .permission("allow-set-desktop-setting")
                    .permission("allow-daemon-status")
                    .permission("allow-child-window")
                    .permission("allow-key-focus"),
            )?;
            let layout = layout::load(app.handle());
            let close_to_tray = layout.close_to_tray();
            app.manage(layout);
            #[cfg(windows)]
            app.manage(embeds::FrameTargets::default());
            tray::set_enabled(app.handle(), close_to_tray);
            startup::refresh();

            let board_url: Url = format!("{base}/").parse()?;
            let board_origin = board_url.origin();
            let offline_origin = offline_url().origin();
            let mut url = if daemon_up { board_url } else { offline_url() };
            if let Some(tab) = board::tab_from_args(&args) {
                url.set_fragment(Some(&tab));
            }
            let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
                .title("Scribe")
                .zoom_hotkeys_enabled(true)
                // Let the board's HTML drop handlers receive files on Windows.
                .disable_drag_drop_handler()
                .on_download(downloads::handle)
                .inner_size(1280.0, 800.0)
                .min_inner_size(320.0, 240.0)
                .decorations(true)
                .visible(false)
                .on_new_window(|url, _| {
                    board::open_external(url.as_str());
                    NewWindowResponse::Deny
                })
                .on_navigation(move |url| {
                    if url.origin() == board_origin || url.origin() == offline_origin {
                        return true;
                    }
                    board::open_external(url.as_str());
                    false
                })
                .build()?;
            // Created with decorations and stripped here: a window built undecorated comes out a
            // caption-height taller than asked, and that extra height leaks into the saved layout.
            window.set_decorations(false)?;
            layout::apply_initial(&window);
            #[cfg(windows)]
            {
                keys::install(&window);
                embeds::install(&window, board::port());
                drops::install(&window);
            }
            // Started with the OS and kept in the tray: stay there until opened.
            let autostart = args.iter().any(|arg| arg == startup::ARG);
            if !(autostart && close_to_tray) {
                focus(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}
