//! Let sites that refuse framing load in board frames anyway.
//!
//! X-Frame-Options and CSP frame-ancestors are enforced on the response, after the page has no
//! say, so they are dropped from frame documents through the DevTools Fetch domain before the
//! browser reads them. A cross-origin frame is its own DevTools target and its later navigations
//! never reach the page's session, so every frame target is auto-attached and intercepted too.
//! The board's own pages keep their headers.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
    ICoreWebView2DevToolsProtocolEventReceivedEventArgs2, ICoreWebView2_11,
};
use webview2_com::{take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

/// Frame targets have separate media emulation; remember live sessions for each window.
#[derive(Default)]
pub struct FrameTargets(Mutex<HashMap<String, HashSet<String>>>);

pub fn forget_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if let Some(targets) = app.try_state::<FrameTargets>() {
        targets.0.lock().unwrap().remove(label);
    }
}

pub fn set_reduced_motion(window: &WebviewWindow, on: bool) {
    let sessions = window.state::<FrameTargets>().0.lock().unwrap()
        .get(window.label()).cloned().unwrap_or_default();
    let _ = window.with_webview(move |webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            if let Ok(cdp) = core.cast::<ICoreWebView2_11>() {
                apply_motion(&cdp, "", on);
                for session in sessions {
                    apply_motion(&cdp, &session, on);
                }
            }
        }
    });
}

fn motion_features(on: bool) -> Value {
    if on {
        json!({ "features": [{ "name": "prefers-reduced-motion", "value": "reduce" }] })
    } else {
        // Removing the override restores the OS preference, including OS-level reduce.
        json!({ "features": [] })
    }
}

unsafe fn apply_motion(cdp: &ICoreWebView2_11, session: &str, on: bool) {
    send(cdp, session, "Emulation.setEmulatedMedia", motion_features(on));
}

pub fn install(window: &WebviewWindow, board_port: u16) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    app.state::<FrameTargets>().0.lock().unwrap().insert(label.clone(), HashSet::new());
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let _ = intercept(&core, board_port, &app, &label);
    });
}

unsafe fn intercept(core: &ICoreWebView2, board_port: u16, app: &tauri::AppHandle, label: &str) -> windows::core::Result<()> {
    let cdp = core.cast::<ICoreWebView2_11>()?;

    let for_paused = cdp.clone();
    let paused = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        if let Some((session, params)) = args.as_ref().and_then(|args| unsafe { event(args) }) {
            unsafe { on_paused(&for_paused, &session, &params, board_port) };
        }
        Ok(())
    }));
    let mut token = 0i64;
    core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Fetch.requestPaused"))?
        .add_DevToolsProtocolEventReceived(&paused, &mut token)?;

    let for_attached = cdp.clone();
    let for_motion = app.clone();
    let window_label = label.to_owned();
    let attached = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let child = args.as_ref().and_then(|args| unsafe { event(args) }).and_then(|(_, params)| {
            params.get("sessionId").and_then(Value::as_str).map(str::to_owned)
        });
        if let Some(child) = child {
            for_motion.state::<FrameTargets>().0.lock().unwrap()
                .entry(window_label.clone()).or_default().insert(child.clone());
            unsafe {
                watch(&for_attached, &child);
                apply_motion(&for_attached, &child, for_motion.state::<crate::layout::LayoutState>().reduced_motion());
                send(&for_attached, &child, "Runtime.runIfWaitingForDebugger", json!({}));
            }
        }
        Ok(())
    }));
    core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Target.attachedToTarget"))?
        .add_DevToolsProtocolEventReceived(&attached, &mut token)?;

    let for_detached = app.clone();
    let window_label = label.to_owned();
    let detached = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        if let Some((_, params)) = args.as_ref().and_then(|args| unsafe { event(args) }) {
            if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                if let Some(sessions) = for_detached.state::<FrameTargets>().0.lock().unwrap().get_mut(&window_label) {
                    sessions.remove(session);
                }
            }
        }
        Ok(())
    }));
    core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Target.detachedFromTarget"))?
        .add_DevToolsProtocolEventReceived(&detached, &mut token)?;

    watch(&cdp, "");
    apply_motion(&cdp, "", app.state::<crate::layout::LayoutState>().reduced_motion());
    Ok(())
}

/// Pause frame documents at their response, and hold new frame targets until they are watched too.
unsafe fn watch(cdp: &ICoreWebView2_11, session: &str) {
    send(
        cdp,
        session,
        "Fetch.enable",
        json!({ "patterns": [{ "urlPattern": "*", "resourceType": "Document", "requestStage": "Response" }] }),
    );
    send(
        cdp,
        session,
        "Target.setAutoAttach",
        json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
    );
}

unsafe fn on_paused(cdp: &ICoreWebView2_11, session: &str, params: &Value, board_port: u16) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let url = params.pointer("/request/url").and_then(Value::as_str).unwrap_or_default();
    let headers = params.get("responseHeaders").and_then(Value::as_array);
    let status = params.get("responseStatusCode").and_then(Value::as_u64);
    let rewritten = match (headers, status) {
        (Some(headers), Some(status)) if !is_board_page(url, board_port) => {
            allow_framing(headers).map(|headers| (headers, status))
        }
        _ => None,
    };
    match rewritten {
        Some((headers, status)) => fulfill(cdp, session, request_id, status, headers),
        None => send(cdp, session, "Fetch.continueRequest", json!({ "requestId": request_id })),
    }
}

/// Chromium has already parsed the CSP by the pause and ignores headers changed through
/// Fetch.continueResponse, so the response is rebuilt with Fetch.fulfillRequest. The body comes
/// back decoded, so its encoding and length headers are dropped with it.
unsafe fn fulfill(cdp: &ICoreWebView2_11, session: &str, request_id: &str, status: u64, headers: Vec<Value>) {
    let headers: Vec<Value> = headers
        .into_iter()
        .filter(|header| {
            let name = header.get("name").and_then(Value::as_str).unwrap_or_default();
            !name.eq_ignore_ascii_case("content-encoding") && !name.eq_ignore_ascii_case("content-length")
        })
        .collect();
    let for_body = cdp.clone();
    let owned_session = session.to_owned();
    let owned_request = request_id.to_owned();
    call(cdp, session, "Fetch.getResponseBody", json!({ "requestId": request_id }), move |result| {
        let body = result.as_ref().and_then(|result| {
            let body = result.get("body")?.as_str()?;
            let encoded = result.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false);
            Some(if encoded { body.to_owned() } else { BASE64.encode(body) })
        });
        let (method, params) = match body {
            Some(body) => (
                "Fetch.fulfillRequest",
                json!({ "requestId": owned_request, "responseCode": status, "responseHeaders": headers, "body": body }),
            ),
            None => ("Fetch.continueRequest", json!({ "requestId": owned_request })),
        };
        unsafe { send(&for_body, &owned_session, method, params) };
    });
}

/// The board and its tab pages (127.0.0.1, 127.0.0.2 and each page's own <label>.localhost, on the board port).
fn is_board_page(url: &str, board_port: u16) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    let board_host = match url.host_str() {
        Some("127.0.0.1" | "127.0.0.2") => true,
        Some(host) => host.strip_suffix(".localhost").is_some_and(is_page_label),
        None => false,
    };
    board_host && url.port_or_known_default() == Some(board_port)
}

/// A page host's label, as the daemon names it (src/config.ts pageHost): t-<hex> or x<hex>.
fn is_page_label(label: &str) -> bool {
    let hex = label.strip_prefix("t-").or_else(|| label.strip_prefix('x')).unwrap_or_default();
    !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The response headers without anything that forbids framing, or None when nothing did.
fn allow_framing(headers: &[Value]) -> Option<Vec<Value>> {
    let mut changed = false;
    let mut kept = Vec::with_capacity(headers.len());
    for header in headers {
        let name = header.get("name").and_then(Value::as_str).unwrap_or_default();
        let value = header.get("value").and_then(Value::as_str).unwrap_or_default();
        if name.eq_ignore_ascii_case("x-frame-options") {
            changed = true;
            continue;
        }
        if name.eq_ignore_ascii_case("content-security-policy") {
            if let Some(policy) = without_frame_ancestors(value) {
                changed = true;
                if !policy.is_empty() {
                    kept.push(json!({ "name": name, "value": policy }));
                }
                continue;
            }
        }
        kept.push(header.clone());
    }
    changed.then_some(kept)
}

/// The policy list with every frame-ancestors directive removed, or None when it had none.
fn without_frame_ancestors(csp: &str) -> Option<String> {
    let mut found = false;
    let policies: Vec<String> = csp
        .split(',')
        .map(|policy| {
            let directives: Vec<&str> = policy
                .split(';')
                .map(str::trim)
                .filter(|directive| {
                    let name = directive.split_ascii_whitespace().next().unwrap_or_default();
                    let ancestors = name.eq_ignore_ascii_case("frame-ancestors");
                    found |= ancestors;
                    !directive.is_empty() && !ancestors
                })
                .collect();
            directives.join("; ")
        })
        .filter(|policy| !policy.is_empty())
        .collect();
    found.then(|| policies.join(", "))
}

unsafe fn event(args: &ICoreWebView2DevToolsProtocolEventReceivedEventArgs) -> Option<(String, Value)> {
    let mut json = PWSTR::null();
    args.ParameterObjectAsJson(&mut json).ok()?;
    let params = serde_json::from_str(&take_pwstr(json)).ok()?;
    let mut session = PWSTR::null();
    let session = match args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>() {
        Ok(args) if args.SessionId(&mut session).is_ok() => take_pwstr(session),
        _ => String::new(),
    };
    Some((session, params))
}

/// Fire and forget: a failed call (a worker without Fetch, a target already gone) changes nothing.
unsafe fn send(cdp: &ICoreWebView2_11, session: &str, method: &str, params: Value) {
    call(cdp, session, method, params, |_| {});
}

/// `on_result` gets the method's result, or None when the call failed.
unsafe fn call(
    cdp: &ICoreWebView2_11,
    session: &str,
    method: &str,
    params: Value,
    on_result: impl FnOnce(Option<Value>) + 'static,
) {
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
        on_result(status.ok().and_then(|_| serde_json::from_str(&json).ok()));
        Ok(())
    }));
    let _ = cdp.CallDevToolsProtocolMethodForSession(
        &HSTRING::from(session),
        &HSTRING::from(method),
        &HSTRING::from(params.to_string()),
        &handler,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> Value {
        json!({ "name": name, "value": value })
    }

    #[test]
    fn drops_x_frame_options_in_any_case() {
        let kept = allow_framing(&[header("X-Frame-Options", "DENY"), header("content-type", "text/html")]).unwrap();
        assert_eq!(kept, vec![header("content-type", "text/html")]);
    }

    #[test]
    fn keeps_the_rest_of_the_policy() {
        let kept = allow_framing(&[header(
            "Content-Security-Policy",
            "default-src 'self'; frame-ancestors 'none'; script-src 'self', FRAME-ANCESTORS 'self'",
        )])
        .unwrap();
        assert_eq!(kept, vec![header("Content-Security-Policy", "default-src 'self'; script-src 'self'")]);
    }

    #[test]
    fn drops_a_policy_that_only_forbade_framing() {
        assert_eq!(allow_framing(&[header("content-security-policy", "frame-ancestors 'self';")]).unwrap(), Vec::<Value>::new());
    }

    #[test]
    fn leaves_framable_responses_alone() {
        assert_eq!(allow_framing(&[header("content-security-policy", "default-src *")]), None);
        assert_eq!(allow_framing(&[header("content-security-policy-report-only", "frame-ancestors 'none'")]), None);
    }

    #[test]
    fn board_pages_are_only_the_board_port_on_loopback() {
        assert!(is_board_page("http://127.0.0.1:4747/", 4747));
        assert!(is_board_page("http://127.0.0.2:4747/t/abc", 4747));
        assert!(is_board_page("http://t-ab12cd34.localhost:4747/view/t_ab12cd34", 4747));
        assert!(!is_board_page("http://t-ab12cd34.localhost:8188/", 4747));
        assert!(!is_board_page("http://app.localhost:4747/", 4747));
        assert!(!is_board_page("http://127.0.0.1:8188/", 4747));
        assert!(!is_board_page("https://github.com/", 4747));
    }
}
