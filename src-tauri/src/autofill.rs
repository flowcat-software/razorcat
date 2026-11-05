//! WebView2's form autofill, off. Left on, it remembers what's typed into a text field (a
//! file-name template, a step's label) and offers it again in a browser's "Saved info" popup,
//! which looks out of place in an app and has nothing to offer Razorcat's few fields. Password
//! saving goes with it: there are no passwords to save.
//!
//! WebView2 keeps these as one setting for the browser profile, which all of Razorcat's windows
//! share, and each new webview writes its own (on, by default) into it: so every webview turns
//! them off, the picker's and the recorder's included, or the last one opened turns them back on.

use tauri::{Runtime, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
use windows::core::Interface;

/// Turns autofill and password saving off in `webview`.
pub fn off<R: Runtime>(webview: &Webview<R>) {
    let label = webview.label().to_string();
    let done = webview.with_webview(move |platform| unsafe {
        let settings = platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|s| s.cast::<ICoreWebView2Settings4>());
        match settings {
            Ok(s) => {
                if let Err(e) = s
                    .SetIsGeneralAutofillEnabled(false)
                    .and_then(|()| s.SetIsPasswordAutosaveEnabled(false))
                {
                    logln!("[webview] {label}: autofill stays on: {e}");
                }
            }
            Err(e) => logln!("[webview] {label}: no settings for autofill: {e}"),
        }
    });
    if let Err(e) = done {
        logln!("[webview] {}: autofill stays on: {e}", webview.label());
    }
}
