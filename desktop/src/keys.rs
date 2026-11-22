//! Board shortcuts for every frame, including embedded sites.
//!
//! A cross-origin embed keeps its key events to itself, so neither the board page nor its
//! injected key script ever sees them. WebView2 raises AcceleratorKeyPressed for the whole
//! webview before any frame does (on Linux, WebKitGTK's key-press-event does the same), so the
//! shortcuts are caught here instead, but only while focus is in such an embed (the shell reports
//! it through `key_focus`). The board and Scribe's page frames get first refusal, as in a browser:
//! pages that use a shortcut keep it, and the key script forwards the rest. Keys a browser keeps
//! for itself (reload among them, which WebKitGTK has no key for at all) are caught here everywhere.

use tauri::WebviewWindow;
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Profile2, ICoreWebView2_13,
    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, COREWEBVIEW2_KEY_EVENT_KIND,
    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
#[cfg(windows)]
use webview2_com::{
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    ClearBrowsingDataCompletedHandler, ZoomFactorChangedEventHandler,
};
use std::sync::Mutex;
#[cfg(windows)]
use windows::core::{w, Interface};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

use crate::{layout, KeyBinding};

enum Shortcut {
    /// Ctrl+Shift+M
    Compact,
    /// Board actions the page runs through `window.scribeShortcut`. Ctrl+Shift+T reopens the
    /// last closed tab; Ctrl+Z stays with the page for text undo.
    Board(String),
    /// F5 / Ctrl+R: drop the webview's HTTP cache, then reload, so embedded sites are not stale.
    /// In an embed only that frame reloads.
    Reload,
}

/// Windows whose focus is in a frame that is neither the board nor one of its pages.
static EMBED_FOCUS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn set_embed_focus(label: &str, embed: bool) {
    let mut focused = EMBED_FOCUS.lock().unwrap();
    focused.retain(|other| other != label);
    if embed {
        focused.push(label.to_owned());
    }
}

fn embed_focused(label: &str) -> bool {
    EMBED_FOCUS.lock().unwrap().iter().any(|other| other == label)
}

/// Keys a browser keeps from pages (tabs, windows, reload), and the app's own window key.
/// Everything else reaches the focused frame first unless that frame is an embed.
fn reserved(shortcut: &Shortcut) -> bool {
    match shortcut {
        Shortcut::Compact | Shortcut::Reload => true,
        Shortcut::Board(action) => matches!(
            action.as_str(),
            "next-tab" | "prev-tab" | "close-tab" | "new-page" | "reopen" | "prev-space" | "next-space"
        ),
    }
}

/// Board actions the shell may run natively. Anything else in a key map is ignored.
const NATIVE_ACTIONS: &[&str] = &[
    "new-page", "close-tab", "reopen", "next-tab", "prev-tab", "download", "palette", "library", "spaces",
    "prev-space", "next-space", "help", "settings", "agent-settings", "agent-dock", "agent-side", "agent-full",
];

/// The user's shortcut table from the board (#1022); None until it is sent, which keeps the built-in keys.
static KEY_MAP: Mutex<Option<Vec<KeyBinding>>> = Mutex::new(None);

pub fn set_key_map(bindings: Vec<KeyBinding>) {
    *KEY_MAP.lock().unwrap() = Some(known_bindings(bindings));
}

fn known_bindings(bindings: Vec<KeyBinding>) -> Vec<KeyBinding> {
    bindings.into_iter().filter(|b| NATIVE_ACTIONS.contains(&b.action.as_str())).collect()
}

// Windows virtual keys, which public/keymap.js sends on every platform.
const VK_TAB: u32 = 0x09;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
#[cfg(any(target_os = "linux", test))]
const VK_F1: u32 = 0x70;
const VK_F5: u32 = 0x74;
const VK_OEM_COMMA: u32 = 0xBC;

fn shortcut_for(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<Shortcut> {
    shortcut_in(KEY_MAP.lock().unwrap().as_deref(), key, ctrl, shift, alt)
}

fn shortcut_in(map: Option<&[KeyBinding]>, key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<Shortcut> {
    // Reload and Compact are the shell's own and can't be remapped (public/keymap.js keeps them free).
    if !alt && (key == VK_F5 || (ctrl && key == u32::from(b'R'))) {
        return Some(Shortcut::Reload);
    }
    if ctrl && shift && !alt && key == u32::from(b'M') {
        return Some(Shortcut::Compact);
    }
    if let Some(map) = map {
        return map
            .iter()
            .find(|b| b.key == key && b.ctrl == ctrl && b.shift == shift && b.alt == alt)
            .map(|b| Shortcut::Board(b.action.clone()));
    }
    builtin_shortcut(key, ctrl, shift, alt).map(|action| Shortcut::Board(action.to_owned()))
}

/// The default keys, for a board that hasn't sent its table (older UI, or before it loads).
fn builtin_shortcut(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<&'static str> {
    if ctrl && ((alt && key == u32::from(b'S')) || (!alt && key == VK_OEM_COMMA)) {
        return Some(if shift { "agent-settings" } else { "settings" });
    }
    // Thread settings and actions are handled in chat, where focus can be checked.
    if alt {
        return None;
    }
    if !ctrl {
        return None;
    }
    if key == VK_TAB {
        return Some(if shift { "prev-tab" } else { "next-tab" });
    }
    if shift && (key == VK_PRIOR || key == VK_NEXT) {
        return Some(if key == VK_PRIOR { "prev-space" } else { "next-space" });
    }
    match (u8::try_from(key).ok()?, shift) {
        (b'T', true) => Some("reopen"),
        (b'T' | b'N', false) => Some("new-page"),
        (b'D', false) => Some("palette"),
        (b'S', false) => Some("download"),
        (b'H', false) => Some("help"),
        (b'E', false) => Some("spaces"),
        (b'B', false) => Some("library"),
        (b'W', false) => Some("close-tab"),
        (b'K', false) => Some("agent-dock"),
        (b'L', false) => Some("agent-side"),
        (b'L', true) => Some("agent-full"),
        _ => None,
    }
}

/// Holding Ctrl+Tab keeps cycling, like a browser. Everything else fires once per press.
fn repeats(shortcut: &Shortcut) -> bool {
    matches!(shortcut, Shortcut::Board(action) if action == "next-tab" || action == "prev-tab")
}

#[cfg(windows)]
fn pressed(key: u16) -> bool {
    unsafe { GetKeyState(key as i32) < 0 }
}

#[cfg(windows)]
/// Drop the HTTP cache (disk + memory), then reload. A plain Reload reuses cached embed HTML.
/// `reload` runs once the cache is gone (or could not be dropped).
unsafe fn reload_dropping_http_cache(controller: &ICoreWebView2Controller, reload: impl Fn(&ICoreWebView2) + Clone + 'static) {
    let Ok(core) = controller.CoreWebView2() else {
        return;
    };
    if drop_http_cache_then(core.clone(), reload.clone()).is_err() {
        reload(&core);
    }
}

#[cfg(windows)]
unsafe fn drop_http_cache_then(core: ICoreWebView2, reload: impl Fn(&ICoreWebView2) + Clone + 'static) -> windows::core::Result<()> {
    let after_disk = core.clone();
    let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |_| {
        unsafe {
            if clear_memory_cache_then(after_disk.clone(), reload.clone()).is_err() {
                reload(&after_disk);
            }
        }
        Ok(())
    }));
    core.cast::<ICoreWebView2_13>()?
        .Profile()?
        .cast::<ICoreWebView2Profile2>()?
        .ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)
}

#[cfg(windows)]
unsafe fn clear_memory_cache_then(core: ICoreWebView2, reload: impl Fn(&ICoreWebView2) + 'static) -> windows::core::Result<()> {
    let to_reload = core.clone();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| {
        reload(&to_reload);
        Ok(())
    }));
    core.CallDevToolsProtocolMethod(w!("Network.clearBrowserCache"), w!("{}"), &handler)
}

/// Run a board action in the shell, outside the webview's key callback.
fn run_board_action(window: &WebviewWindow, action: &str) {
    let window = window.clone();
    let script = format!("window.scribeShortcut && window.scribeShortcut({action:?})");
    std::thread::spawn(move || {
        let _ = window.eval(script);
    });
}

#[cfg(windows)]
pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        // Read the native factor so wheel, pinch, reset, and keyboard zoom report the same value.
        let for_zoom = target.clone();
        let zoom_handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(controller) = sender else { return Ok(()) };
            let mut factor = 1.0;
            controller.ZoomFactor(&mut factor)?;
            if factor.is_finite() && factor > 0.0 {
                let window = for_zoom.clone();
                // Leave the WebView2 callback before evaluating script, as with board shortcuts.
                std::thread::spawn(move || {
                    let _ = window.eval(format!(
                        "window.scribeDesktop?.showZoom({factor})"
                    ));
                });
            }
            Ok(())
        }));
        let mut zoom_token = 0i64;
        let _ = controller.add_ZoomFactorChanged(&zoom_handler, &mut zoom_token);
        let for_keys = controller.clone();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                return Ok(());
            }
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            let Some(shortcut) = shortcut_for(key, pressed(VK_CONTROL.0), pressed(VK_SHIFT.0), pressed(VK_MENU.0))
            else {
                return Ok(());
            };
            let in_embed = embed_focused(target.label());
            if !in_embed && !reserved(&shortcut) {
                return Ok(());
            }
            args.SetHandled(true)?;
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            if status.WasKeyDown.as_bool() && !repeats(&shortcut) {
                return Ok(());
            }
            match shortcut {
                Shortcut::Reload if in_embed => {
                    let window = target.clone();
                    reload_dropping_http_cache(&for_keys, move |_| run_board_action(&window, "reload-frame"));
                }
                Shortcut::Reload => reload_dropping_http_cache(&for_keys, |core| {
                    let _ = core.Reload();
                }),
                Shortcut::Compact => {
                    let window = target.clone();
                    // Leave the WebView2 callback before touching the window.
                    std::thread::spawn(move || layout::toggle_compact(&window));
                }
                Shortcut::Board(action) => run_board_action(&target, &action),
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
    });
}

/// The key held down last, so auto-repeat runs a shortcut once (GDK 3 doesn't flag repeats).
#[cfg(target_os = "linux")]
static HELD: Mutex<Option<u16>> = Mutex::new(None);

/// A GDK key as the Windows virtual key public/keymap.js binds, matched as keymap.js matches the
/// event: letters by the character the layout types (by position on a non-Latin layout), digits
/// and punctuation by position. `keyval` is the key's unshifted keyval, `keycode` its X keycode.
#[cfg(any(target_os = "linux", test))]
fn virtual_key(keyval: u32, keycode: u16) -> Option<u32> {
    const LETTERS: [(u16, &[u8]); 3] = [(24, b"QWERTYUIOP"), (38, b"ASDFGHJKL"), (52, b"ZXCVBNM")];
    match keyval {
        0x61..=0x7a => return Some(keyval - 0x20),
        0x41..=0x5a => return Some(keyval),
        // Tab, ISO_Left_Tab (Shift+Tab).
        0xff09 | 0xfe20 => return Some(VK_TAB),
        0x20 => return Some(0x20),
        0xff0d | 0xff8d => return Some(0x0d),
        0xff08 => return Some(0x08),
        0xffff => return Some(0x2e),
        0xff63 => return Some(0x2d),
        0xff50 => return Some(0x24),
        0xff57 => return Some(0x23),
        0xff55 => return Some(VK_PRIOR),
        0xff56 => return Some(VK_NEXT),
        0xff51 => return Some(0x25),
        0xff52 => return Some(0x26),
        0xff53 => return Some(0x27),
        0xff54 => return Some(0x28),
        // F1..F24.
        0xffbe..=0xffd5 => return Some(VK_F1 + (keyval - 0xffbe)),
        _ => {}
    }
    match keycode {
        10..=18 => Some(u32::from(b'1') + u32::from(keycode - 10)),
        19 => Some(u32::from(b'0')),
        20 => Some(0xbd),
        21 => Some(0xbb),
        34 => Some(0xdb),
        35 => Some(0xdd),
        47 => Some(0xba),
        48 => Some(0xde),
        49 => Some(0xc0),
        // The apostrophe key on Nordic layouts sits where US has backslash (as in keymap.js).
        51 => Some(if keyval == 0x5c || keyval == 0x7c { 0xdc } else { 0xde }),
        59 => Some(VK_OEM_COMMA),
        60 => Some(0xbe),
        61 => Some(0xbf),
        94 => Some(0xe2),
        _ => LETTERS.iter().find_map(|(first, row)| {
            let at = usize::from(keycode.checked_sub(*first)?);
            row.get(at).map(|&letter| u32::from(letter))
        }),
    }
}

/// Drop the HTTP cache (disk + memory), then reload, as on Windows: a plain reload reuses cached embed HTML.
#[cfg(target_os = "linux")]
fn reload_dropping_http_cache(view: &webkit2gtk::WebView, reload: impl FnOnce() + Send + 'static) {
    use webkit2gtk::{gio, glib, WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};
    match view.website_data_manager() {
        Some(data) => data.clear(
            WebsiteDataTypes::DISK_CACHE | WebsiteDataTypes::MEMORY_CACHE,
            glib::TimeSpan::from_seconds(0),
            None::<&gio::Cancellable>,
            move |_| reload(),
        ),
        None => reload(),
    }
}

#[cfg(target_os = "linux")]
pub fn install(window: &WebviewWindow) {
    use gtk::prelude::*;
    use gtk::{gdk, glib::Propagation};
    use webkit2gtk::WebViewExt;

    let target = window.clone();
    let _ = window.with_webview(move |webview| {
        let view = webview.inner();
        view.connect_key_release_event(|_, event| {
            let mut held = HELD.lock().unwrap();
            if *held == Some(event.hardware_keycode()) {
                *held = None;
            }
            Propagation::Proceed
        });
        // Connected handlers run before WebKitGTK's own, which hands the key to the page.
        view.connect_key_press_event(move |view, event| {
            if event.is_modifier() {
                return Propagation::Proceed;
            }
            let state = event.state();
            let keycode = event.hardware_keycode();
            // The key without Shift, so Ctrl+Shift+T reads T and Ctrl+Shift+Tab reads Tab.
            let keyval = gdk::Keymap::for_display(&view.display())
                .and_then(|keymap| {
                    keymap.translate_keyboard_state(u32::from(keycode), gdk::ModifierType::empty(), i32::from(event.group()))
                })
                .map_or(*event.keyval(), |(keyval, ..)| keyval);
            let Some(key) = virtual_key(keyval, keycode) else { return Propagation::Proceed };
            let Some(shortcut) = shortcut_for(
                key,
                state.contains(gdk::ModifierType::CONTROL_MASK),
                state.contains(gdk::ModifierType::SHIFT_MASK),
                state.contains(gdk::ModifierType::MOD1_MASK),
            ) else {
                return Propagation::Proceed;
            };
            let in_embed = embed_focused(target.label());
            if !in_embed && !reserved(&shortcut) {
                return Propagation::Proceed;
            }
            let repeat = HELD.lock().unwrap().replace(keycode) == Some(keycode);
            if repeat && !repeats(&shortcut) {
                return Propagation::Stop;
            }
            match shortcut {
                Shortcut::Reload if in_embed => {
                    let window = target.clone();
                    reload_dropping_http_cache(view, move || run_board_action(&window, "reload-frame"));
                }
                Shortcut::Reload => {
                    let window = target.clone();
                    reload_dropping_http_cache(view, move || {
                        let _ = window.with_webview(|webview| webview.inner().reload());
                    });
                }
                Shortcut::Compact => {
                    let window = target.clone();
                    // Leave the GTK handler before touching the window.
                    std::thread::spawn(move || layout::toggle_compact(&window));
                }
                Shortcut::Board(action) => run_board_action(&target, &action),
            }
            Propagation::Stop
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserved_key(key: u8, shift: bool) -> bool {
        reserved(&shortcut_for(u32::from(key), true, shift, false).unwrap())
    }

    #[test]
    fn pages_get_first_refusal_except_on_browser_keys() {
        for key in [b'K', b'L', b'E', b'B', b'D', b'S', b'H'] {
            assert!(!reserved_key(key, false), "Ctrl+{}", key as char);
        }
        for key in [b'T', b'N', b'W', b'R'] {
            assert!(reserved_key(key, false), "Ctrl+{}", key as char);
        }
        assert!(reserved_key(b'T', true));
        assert!(reserved(&shortcut_for(VK_TAB, true, false, false).unwrap()));
        assert!(reserved(&shortcut_for(VK_F5, false, false, false).unwrap()));
    }

    #[test]
    fn thread_shortcuts_stay_with_the_focused_frame() {
        for (key, shift) in [(0xBE, false), (0xBE, true), (0xDE, false), (u32::from(b'J'), false), (u32::from(b'K'), true)] {
            assert!(shortcut_for(key, true, shift, false).is_none());
        }
    }

    #[test]
    fn a_key_map_replaces_the_built_in_keys() {
        let bind = |action: &str, key: u8, shift: bool| KeyBinding { action: action.into(), key: u32::from(key), ctrl: true, shift, alt: false };
        let map = known_bindings(vec![bind("close-tab", b'Q', false), bind("not-an-action", b'P', false)]);
        let at = |key: u8, shift: bool| shortcut_in(Some(&map), u32::from(key), true, shift, false);
        assert!(matches!(at(b'Q', false), Some(Shortcut::Board(a)) if a == "close-tab"));
        assert!(at(b'W', false).is_none());
        assert!(at(b'P', false).is_none());
        // Reload and Compact stay.
        assert!(matches!(at(b'R', false), Some(Shortcut::Reload)));
        assert!(matches!(at(b'M', true), Some(Shortcut::Compact)));
    }

    #[test]
    fn embed_focus_is_per_window() {
        set_embed_focus("a", true);
        set_embed_focus("b", false);
        assert!(embed_focused("a") && !embed_focused("b"));
        set_embed_focus("a", false);
        assert!(!embed_focused("a"));
    }

    #[test]
    fn gdk_keys_read_as_the_virtual_keys_keymap_js_binds() {
        // Letters by the layout's character, whatever their position (Dvorak's R is on US O).
        assert_eq!(virtual_key(u32::from(b'r'), 32), Some(u32::from(b'R')));
        // A non-Latin layout falls back to the position.
        assert_eq!(virtual_key(0x6d6, 27), Some(u32::from(b'R')));
        assert_eq!(virtual_key(0xfe20, 23), Some(VK_TAB));
        assert_eq!(virtual_key(0xffc2, 71), Some(VK_F5));
        assert_eq!(virtual_key(0x31, 10), Some(u32::from(b'1')));
        assert_eq!(virtual_key(0x2c, 59), Some(VK_OEM_COMMA));
        // Nordic ' on the US backslash key.
        assert_eq!(virtual_key(0x27, 51), Some(0xde));
        assert_eq!(virtual_key(0x5c, 51), Some(0xdc));
        assert_eq!(virtual_key(0xffe1, 50), None);
    }
}
