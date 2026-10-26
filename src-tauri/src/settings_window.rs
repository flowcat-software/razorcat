//! The settings window: 0–1 instance, created on demand.

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "settings";

/// Focus the settings window, creating it if needed, at `section` (a section's id) if given.
/// It starts hidden and the page shows it after its first render, so it never flashes white.
pub fn open(app: &AppHandle, section: Option<&str>) {
    // Section ids are plain words; anything else is ignored.
    let section = section.filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase()));
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(section) = section {
            // The page follows its hash (SettingsApp.tsx).
            let _ = window.eval(format!("location.hash = '{section}'"));
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Creating a webview from the main thread's event handlers can deadlock on Windows, so
    // build it elsewhere.
    let app = app.clone();
    let page = match section {
        Some(s) => format!("settings.html#{s}"),
        None => "settings.html".into(),
    };
    std::thread::spawn(move || {
        let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(page.into()));
        let built = crate::appearance::themed(&app, builder)
            .title(format!("{} Settings", crate::product_name(&app)))
            .inner_size(920.0, 680.0)
            .min_inner_size(640.0, 460.0)
            .center()
            .visible(false)
            .build();
        match built {
            Ok(window) => {
                crate::webview_crash::watch(&window);
                crate::browser_keys::disable(&window);
                // Fallback in case the page never signals it rendered.
                std::thread::sleep(Duration::from_secs(3));
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Err(e) => logln!("[settings] window failed: {e}"),
        }
    });
}
