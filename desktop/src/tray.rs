//! The tray icon that holds the app while "close to tray" is on. It exists only while that setting does.
//!
//! A main window closed to the tray is let go after a short while: hiding a webview frees none of its
//! video memory, closing it frees all of it. Until it is opened again, a small hidden page
//! (public/tray.html) plays the thread sounds the board would.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

const TRAY: &str = "tray";
/// The hidden window that plays sounds while the main one is let go.
const SOUNDS: &str = "tray-sounds";
/// How long a main window closed to the tray stays loaded, so reopening it soon after is instant.
const UNLOAD_AFTER: Duration = Duration::from_secs(15);
/// How long after the board window closes its leftover web processes are ended.
const SETTLE: Duration = Duration::from_secs(3);
/// Bumped whenever the main window is shown or hidden, so a pending unload sees it is stale.
static VISIBILITY: AtomicU64 = AtomicU64::new(0);
/// Set while the main window is destroyed for the tray, so its page windows stay open.
static UNLOADING: AtomicBool = AtomicBool::new(false);

/// Whether the tray keeps the app running with no board window.
pub fn holds_app<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY).is_some()
}

/// The main window went to the tray: let it go unless it is shown again first.
pub fn hidden<R: Runtime>(app: &AppHandle<R>) {
    let generation = VISIBILITY.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(UNLOAD_AFTER);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if VISIBILITY.load(Ordering::SeqCst) != generation || !holds_app(&handle) {
                return;
            }
            let Some(window) = handle.get_webview_window(crate::MAIN) else {
                return;
            };
            if window.is_visible().unwrap_or(true) {
                return;
            }
            UNLOADING.store(true, Ordering::SeqCst);
            if window.destroy().is_err() {
                UNLOADING.store(false, Ordering::SeqCst);
                return;
            }
            let app = handle.clone();
            std::thread::spawn(move || {
                // Give WebKit a moment to close the board's pages first.
                std::thread::sleep(SETTLE);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if VISIBILITY.load(Ordering::SeqCst) != generation || handle.get_webview_window(crate::MAIN).is_some() {
                        return;
                    }
                    // Page windows still use their processes; with none open, every one left over is spare.
                    #[cfg(target_os = "linux")]
                    if handle.webview_windows().is_empty() {
                        end_spare_web_processes();
                    }
                    start_sounds(&handle);
                });
            });
        });
    });
}

/// WebKitGTK keeps a closed board's web processes for reuse (its process cache, a prewarmed one), and
/// with them their video memory, for up to half an hour. End the ones under this process.
#[cfg(target_os = "linux")]
fn end_spare_web_processes() {
    let mut parents = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        // stat: "pid (comm) state ppid ...", and comm may hold spaces or parentheses.
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let comm = stat.get(stat.find('(').map_or(0, |open| open + 1)..close).unwrap_or("").to_string();
        let Some(ppid) = stat[close + 1..].split_whitespace().nth(1).and_then(|ppid| ppid.parse::<u32>().ok()) else {
            continue;
        };
        parents.insert(pid, (ppid, comm));
    }
    let me = std::process::id();
    // The web processes may sit under WebKit's bubblewrap sandbox, so look at every descendant.
    let descends = |mut pid: u32| {
        while let Some((ppid, _)) = parents.get(&pid) {
            if *ppid == me {
                return true;
            }
            if *ppid <= 1 {
                return false;
            }
            pid = *ppid;
        }
        false
    };
    for (pid, (_, comm)) in &parents {
        // comm is cut to 15 characters: "WebKitWebProces".
        if comm.starts_with("WebKitWebProces") && descends(*pid) {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

/// The main window is on screen again (or built again): the stand-in goes.
pub fn shown<R: Runtime>(app: &AppHandle<R>) {
    VISIBILITY.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(SOUNDS) {
        let _ = window.destroy();
    }
}

/// For the main window's Destroyed event: whether it was let go in the tray rather than closed.
pub fn take_unloading() -> bool {
    UNLOADING.swap(false, Ordering::SeqCst)
}

/// Started with the OS into the tray: only the stand-in until the board is opened.
pub fn start_sounds<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(SOUNDS).is_some() {
        return;
    }
    let Ok(url) = format!("{}/tray.html", crate::board::base_url()).parse::<Url>() else {
        return;
    };
    let built = WebviewWindowBuilder::new(app, SOUNDS, WebviewUrl::External(url))
        .title("Scribe")
        .additional_browser_args(crate::BROWSER_ARGS)
        .visible(false)
        .skip_taskbar(true)
        .build();
    #[cfg(target_os = "linux")]
    if let Ok(window) = &built {
        use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
        // It draws nothing, so it needs no GPU.
        let _ = window.with_webview(|webview| {
            if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                settings.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
            }
        });
    }
    if let Err(err) = built {
        eprintln!("Could not start the tray's sound page: {err}");
    }
}

pub fn set_enabled(app: &AppHandle, on: bool) {
    if !on {
        if let Some(tray) = app.remove_tray_by_id(TRAY) {
            // Hide before dropping so the icon leaves the tray now, not on the next hover.
            let _ = tray.set_visible(false);
        }
        return;
    }
    if app.tray_by_id(TRAY).is_none() {
        let _ = build(app);
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("Scribe")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show(app: &AppHandle) {
    crate::show_main(app, None);
}
