//! Disk paths for files and folders dropped on the board.
//!
//! The board keeps WebView2's HTML drag and drop (see `disable_drag_drop_handler`), and a page
//! only gets a dropped item's contents, never where it lives. The board hands the dropped File
//! objects over with `chrome.webview.postMessageWithAdditionalObjects("scribe-drop-paths:<id>")`;
//! WebView2 gives the host their paths, and they go back to the board as
//! `{ type: "scribe-drop-paths", id, paths }`, so a dropped folder can be linked to disk
//! instead of copied.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

const PREFIX: &str = "scribe-drop-paths:";

pub fn install(window: &WebviewWindow) {
    let board = format!("{}/", crate::board::base_url());
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let Some(id) = request_id(&args) else { return Ok(()) };
            // Only the board itself may ask; pages run in frames and embeds come from elsewhere.
            let mut source = PWSTR::null();
            if args.Source(&mut source).is_err() || !take_pwstr(source).starts_with(&board) {
                return Ok(());
            }
            let reply = serde_json::json!({ "type": "scribe-drop-paths", "id": id, "paths": paths(&args) });
            let _ = sender.PostWebMessageAsJson(&HSTRING::from(reply.to_string()));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}

/// The request id of a drop-paths message; other web messages (Tauri's own IPC) are left alone.
unsafe fn request_id(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<String> {
    let mut text = PWSTR::null();
    args.TryGetWebMessageAsString(&mut text).ok()?;
    let text = take_pwstr(text);
    text.strip_prefix(PREFIX).map(str::to_owned)
}

/// The path of each attached object, in order; null for one that is not a file.
unsafe fn paths(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Vec<Option<String>> {
    let Ok(objects) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().and_then(|args| args.AdditionalObjects()) else {
        return Vec::new();
    };
    let mut count = 0u32;
    if objects.Count(&mut count).is_err() {
        return Vec::new();
    }
    (0..count)
        .map(|index| {
            let file = objects.GetValueAtIndex(index).ok()?.cast::<ICoreWebView2File>().ok()?;
            let mut path = PWSTR::null();
            file.Path(&mut path).ok()?;
            Some(take_pwstr(path)).filter(|path| !path.is_empty())
        })
        .collect()
}
