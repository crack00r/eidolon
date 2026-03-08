use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuItem},
    Manager, AppHandle,
};

use crate::DaemonState;

pub fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "Hide Window", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Eidolon AI Assistant")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                // Gracefully stop daemon before exiting.
                // Send SIGTERM and spawn an async task to wait for exit,
                // avoiding blocking the main thread (M-2 fix).
                if let Some(state) = app.try_state::<DaemonState>() {
                    crate::graceful_stop_daemon(&state);
                }
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let start = std::time::Instant::now();
                    let timeout = std::time::Duration::from_secs(5);
                    loop {
                        if start.elapsed() >= timeout {
                            break;
                        }
                        let is_done = app_handle
                            .try_state::<DaemonState>()
                            .map(|state| {
                                let daemon = state.0.lock().unwrap_or_else(|e| e.into_inner());
                                daemon.is_none()
                            })
                            .unwrap_or(true);
                        if is_done {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    app_handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
