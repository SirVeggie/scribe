//! The tray icon that holds the app while "close to tray" is on. It exists only while that setting does.
//!
//! A main window closed to the tray keeps running, so its sounds and notifications still come, but
//! drops what it holds in video memory until it is shown again: WebKitGTK renders in software,
//! WebView2 goes invisible with a low memory target.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime, WebviewWindow};

const TRAY: &str = "tray";

/// The main window went to the tray.
pub fn hidden<R: Runtime>(window: &WebviewWindow<R>) {
    set_background(window, true);
}

/// The main window is on screen again.
pub fn shown<R: Runtime>(window: &WebviewWindow<R>) {
    set_background(window, false);
}

#[cfg(target_os = "linux")]
fn set_background<R: Runtime>(window: &WebviewWindow<R>, on: bool) {
    use webkit2gtk::{HardwareAccelerationPolicy, SettingsExt, WebViewExt};
    let _ = window.with_webview(move |webview| {
        let Some(settings) = WebViewExt::settings(&webview.inner()) else {
            return;
        };
        let policy = if on { HardwareAccelerationPolicy::Never } else { HardwareAccelerationPolicy::Always };
        if settings.hardware_acceleration_policy() != policy {
            settings.set_hardware_acceleration_policy(policy);
        }
    });
}

#[cfg(windows)]
fn set_background<R: Runtime>(window: &WebviewWindow<R>, on: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let _ = controller.SetIsVisible(!on);
        if let Ok(core) = controller.CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_19>()) {
            let level = if on { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(not(any(windows, target_os = "linux")))]
fn set_background<R: Runtime>(_window: &WebviewWindow<R>, _on: bool) {}

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
