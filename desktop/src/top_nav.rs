//! Linux (WebKitGTK): keep a window's top document on the board.
//!
//! WebKitGTK asks the navigation handler about every frame's navigations and doesn't say which frame,
//! so there a handler that refuses off-board URLs also refuses the board's own tab pages (each on its
//! own <label>.localhost) and embedded sites, and sends them to the browser. On Linux the handler lets
//! every navigation through, and the window's own document is held to the board here instead:
//! load-changed fires only for the main frame, and a load that would leave the board is stopped as it
//! starts and opened in the browser, as the handler does on Windows.

use tauri::{Url, WebviewWindow};
use webkit2gtk::{LoadEvent, WebViewExt};

pub fn install(window: &WebviewWindow, allowed: impl Fn(&Url) -> bool + Send + 'static) {
    let _ = window.with_webview(move |webview| {
        webview.inner().connect_load_changed(move |view, event| {
            if !matches!(event, LoadEvent::Started | LoadEvent::Redirected) {
                return;
            }
            let Some(url) = view.uri().and_then(|uri| uri.parse::<Url>().ok()) else {
                return;
            };
            if allowed(&url) {
                return;
            }
            view.stop_loading();
            crate::board::open_external(url.as_str());
        });
    });
}
