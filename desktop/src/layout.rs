//! Window geometry for the normal and compact form factors, remembered separately, and the window
//! settings saved beside it.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window, WindowEvent};

use crate::{board, startup, CHILD_PREFIX, MAIN};

const NORMAL_SIZE: (f64, f64) = (1280.0, 800.0);
const COMPACT_SIZE: (f64, f64) = (440.0, 600.0);
const COMPACT_MARGIN: f64 = 16.0;
/// A saved rect must overlap a monitor by this much to be restored.
const MIN_VISIBLE: i64 = 64;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Layout {
    normal: Option<Rect>,
    normal_maximized: bool,
    compact: Option<Rect>,
    compact_mode: bool,
    compact_on_top: bool,
    close_to_tray: bool,
    reduced_motion: bool,
    dock_child_windows: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            normal: None,
            normal_maximized: false,
            compact: None,
            compact_mode: false,
            compact_on_top: true,
            close_to_tray: false,
            reduced_motion: false,
            dock_child_windows: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_layouts_default_new_preferences_and_choices_survive_reload() {
        let mut layout: Layout = serde_json::from_str(r#"{"compactOnTop":false}"#).unwrap();
        assert!(!layout.reduced_motion);
        assert!(!layout.compact_on_top);
        assert!(layout.dock_child_windows);
        layout.reduced_motion = true;
        layout.dock_child_windows = true;
        let saved = serde_json::to_string(&layout).unwrap();
        let restored: Layout = serde_json::from_str(&saved).unwrap();
        assert!(restored.reduced_motion);
        assert!(!restored.compact_on_top);
        assert!(restored.dock_child_windows);
    }
}

pub struct LayoutState {
    layout: Mutex<Layout>,
    path: PathBuf,
    last_maximized: Mutex<bool>,
}

/// What the board page needs to draw its window controls and desktop settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    /// Increase this and public/desktop.js's requirement when native UI APIs change.
    api_revision: u32,
    version: &'static str,
    built_at: &'static str,
    executable: Option<String>,
    compact: bool,
    maximized: bool,
    compact_on_top: bool,
    open_from_agents: bool,
    close_to_tray: bool,
    reduced_motion: bool,
    dock_child_windows: bool,
    child_docking_supported: bool,
    launch_at_startup: bool,
    /// Hidden in the tray. The page tells the daemon, so agents open the window again.
    hidden: bool,
}

pub fn load<R: Runtime>(app: &tauri::AppHandle<R>) -> LayoutState {
    let path = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| board::data_dir())
        .join("window.json");
    let layout = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    LayoutState {
        layout: Mutex::new(layout),
        path,
        last_maximized: Mutex::new(false),
    }
}

impl LayoutState {
    pub fn close_to_tray(&self) -> bool {
        self.layout.lock().unwrap().close_to_tray
    }

    pub fn reduced_motion(&self) -> bool {
        self.layout.lock().unwrap().reduced_motion
    }

    pub fn dock_child_windows(&self) -> bool {
        self.layout.lock().unwrap().dock_child_windows
    }
}

fn state<R: Runtime>(window: &WebviewWindow<R>) -> tauri::State<'_, LayoutState> {
    window.state::<LayoutState>()
}

fn save(state: &LayoutState, layout: &Layout) {
    if let Some(dir) = state.path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(layout) {
        let _ = std::fs::write(&state.path, text);
    }
}

/// Size and place the hidden window before it is first shown.
pub fn apply_initial<R: Runtime>(window: &WebviewWindow<R>) {
    let state = state(window);
    let layout = state.layout.lock().unwrap();
    if layout.compact_mode {
        let rect = on_screen(window, layout.compact).unwrap_or_else(|| default_compact(window));
        apply(window, rect);
        let _ = window.set_always_on_top(layout.compact_on_top);
        return;
    }
    match on_screen(window, layout.normal) {
        Some(rect) => apply(window, rect),
        None => {
            let _ = window.set_size(tauri::LogicalSize::new(NORMAL_SIZE.0, NORMAL_SIZE.1));
            let _ = window.center();
        }
    }
    if layout.normal_maximized {
        let _ = window.maximize();
    }
}

pub fn toggle_compact<R: Runtime>(window: &WebviewWindow<R>) {
    // Compact is the main window's form factor; a child window's shortcut does nothing.
    if window.label() != MAIN {
        return;
    }
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let maximized = window.is_maximized().unwrap_or(false);
    if layout.compact_mode {
        if !maximized {
            layout.compact = current_rect(window);
        } else {
            let _ = window.unmaximize();
        }
        layout.compact_mode = false;
        let _ = window.set_always_on_top(false);
        match on_screen(window, layout.normal) {
            Some(rect) => apply(window, rect),
            None => {
                let _ = window.set_size(tauri::LogicalSize::new(NORMAL_SIZE.0, NORMAL_SIZE.1));
                let _ = window.center();
            }
        }
        if layout.normal_maximized {
            let _ = window.maximize();
        }
    } else {
        layout.normal_maximized = maximized;
        if maximized {
            let _ = window.unmaximize();
        } else {
            layout.normal = current_rect(window);
        }
        layout.compact_mode = true;
        let rect = on_screen(window, layout.compact).unwrap_or_else(|| default_compact(window));
        apply(window, rect);
        let _ = window.set_always_on_top(layout.compact_on_top);
    }
    save(&state, &layout);
    drop(layout);
    let _ = window.set_focus();
    push_state(window);
}

pub fn set_compact_on_top<R: Runtime>(window: &WebviewWindow<R>, on_top: bool) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    layout.compact_on_top = on_top;
    if layout.compact_mode {
        let _ = window.set_always_on_top(on_top);
    }
    save(&state, &layout);
}

pub fn set_close_to_tray<R: Runtime>(window: &WebviewWindow<R>, on: bool) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    layout.close_to_tray = on;
    save(&state, &layout);
}

pub fn set_reduced_motion(window: &WebviewWindow, on: bool) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    layout.reduced_motion = on;
    save(&state, &layout);
    drop(layout);
    for (_, window) in window.webview_windows() {
        #[cfg(windows)]
        crate::embeds::set_reduced_motion(&window, on);
        push_state(&window);
    }
}

pub fn set_dock_child_windows(window: &WebviewWindow, on: bool) {
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    layout.dock_child_windows = on;
    save(&state, &layout);
    drop(layout);
    for (_, window) in window.webview_windows() {
        push_state(&window);
    }
}

pub fn desktop_state<R: Runtime>(window: &WebviewWindow<R>) -> DesktopState {
    let state = state(window);
    let layout = state.layout.lock().unwrap();
    DesktopState {
        api_revision: 2,
        version: env!("CARGO_PKG_VERSION"),
        built_at: env!("SCRIBE_DESKTOP_BUILT_AT"),
        executable: std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned()),
        compact: layout.compact_mode,
        maximized: window.is_maximized().unwrap_or(false),
        compact_on_top: layout.compact_on_top,
        open_from_agents: board::read_registration().is_none_or(|registration| registration.open_from_agents),
        close_to_tray: layout.close_to_tray,
        reduced_motion: layout.reduced_motion,
        dock_child_windows: layout.dock_child_windows,
        child_docking_supported: cfg!(windows),
        launch_at_startup: startup::is_enabled(),
        hidden: !window.is_visible().unwrap_or(true),
    }
}

/// Tell the page about a change it did not ask for (shortcut, snap, double-click maximize).
pub fn push_state<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(json) = serde_json::to_string(&desktop_state(window)) else {
        return;
    };
    let _ = window.eval(format!(
        "window.scribeDesktop && window.scribeDesktop.setState({json})"
    ));
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    #[cfg(windows)]
    if matches!(event, WindowEvent::Destroyed) {
        crate::embeds::forget_window(window.app_handle(), window.label());
    }
    if window.label() != MAIN {
        // A child window (a page on its own) keeps no layout. The main window marks its tab, so tell it.
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(main) = window.get_webview_window(MAIN) {
                let _ = main.eval(format!(
                    "window.scribePopout && window.scribePopout.windowClosed({:?})",
                    window.label()
                ));
            }
        }
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        // The main window is gone for good (not hidden in the tray): its pages' windows go with it.
        for (label, child) in window.webview_windows() {
            if label.starts_with(CHILD_PREFIX) {
                let _ = child.close();
            }
        }
        return;
    }
    let Some(webview) = window.get_webview_window(window.label()) else {
        return;
    };
    match event {
        WindowEvent::Resized(_) => {
            let maximized = webview.is_maximized().unwrap_or(false);
            let state = state(&webview);
            let mut last = state.last_maximized.lock().unwrap();
            if *last != maximized {
                *last = maximized;
                drop(last);
                push_state(&webview);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            remember(&webview);
            if state(&webview).close_to_tray() {
                api.prevent_close();
                let _ = webview.hide();
                crate::tray::hidden(&webview);
                push_state(&webview);
            }
        }
        _ => {}
    }
}

/// Save where the window is, for the next launch. A hidden window was saved when it was hidden.
pub fn remember<R: Runtime>(window: &WebviewWindow<R>) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let state = state(window);
    let mut layout = state.layout.lock().unwrap();
    let maximized = window.is_maximized().unwrap_or(false);
    if !layout.compact_mode {
        layout.normal_maximized = maximized;
    }
    if !maximized {
        if let Some(rect) = current_rect(window) {
            if layout.compact_mode {
                layout.compact = Some(rect);
            } else {
                layout.normal = Some(rect);
            }
        }
    }
    save(&state, &layout);
}

fn current_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, rect: Rect) {
    let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
}

/// The saved rect, if it still lands on a connected monitor.
fn on_screen<R: Runtime>(window: &WebviewWindow<R>, rect: Option<Rect>) -> Option<Rect> {
    let rect = rect?;
    let monitors = window.available_monitors().ok()?;
    let visible = monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = i64::from(rect.x).max(i64::from(area.position.x));
        let top = i64::from(rect.y).max(i64::from(area.position.y));
        let right = (i64::from(rect.x) + i64::from(rect.width))
            .min(i64::from(area.position.x) + i64::from(area.size.width));
        let bottom = (i64::from(rect.y) + i64::from(rect.height))
            .min(i64::from(area.position.y) + i64::from(area.size.height));
        right - left >= MIN_VISIBLE && bottom - top >= MIN_VISIBLE
    });
    visible.then_some(rect)
}

/// Bottom-right corner of the monitor the window is on.
fn default_compact<R: Runtime>(window: &WebviewWindow<R>) -> Rect {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Rect {
            x: 100,
            y: 100,
            width: COMPACT_SIZE.0 as u32,
            height: COMPACT_SIZE.1 as u32,
        };
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = (COMPACT_SIZE.0 * scale) as u32;
    let height = (COMPACT_SIZE.1 * scale) as u32;
    let margin = (COMPACT_MARGIN * scale) as i32;
    Rect {
        x: area.position.x + area.size.width as i32 - width as i32 - margin,
        y: area.position.y + area.size.height as i32 - height as i32 - margin,
        width,
        height,
    }
}
