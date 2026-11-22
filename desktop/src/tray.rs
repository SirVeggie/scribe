//! The tray icon that holds the app while "close to tray" is on. It exists only while that setting does.
//!
//! A main window closed to the tray is let go after a short while: its webview's video and other
//! memory go with it, and opening Scribe from the tray builds the window again.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY: &str = "tray";
/// How long a main window closed to the tray stays loaded, so reopening it soon after is instant.
const UNLOAD_AFTER: Duration = Duration::from_secs(15);
/// Bumped whenever the main window is shown or hidden, so a pending unload sees it is stale.
static VISIBILITY: AtomicU64 = AtomicU64::new(0);
/// Set while the main window is destroyed for the tray, so its page windows stay open.
static UNLOADING: AtomicBool = AtomicBool::new(false);

/// Whether the tray keeps the app running with no windows.
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
            }
        });
    });
}

pub fn shown() {
    VISIBILITY.fetch_add(1, Ordering::SeqCst);
}

/// For the main window's Destroyed event: whether it was let go in the tray rather than closed.
pub fn take_unloading() -> bool {
    UNLOADING.swap(false, Ordering::SeqCst)
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
