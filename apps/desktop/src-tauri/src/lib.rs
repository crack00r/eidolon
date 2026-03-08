mod commands;
mod tray;

use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

// SECURITY: The updater pubkey in tauri.conf.json MUST be replaced with a real Ed25519
// public key before any production release. Generate a key pair with:
//   cargo tauri signer generate -w ~/.tauri/eidolon.key
// Then set the pubkey field to the generated public key string.
// An empty or placeholder pubkey disables update signature verification, allowing
// arbitrary code execution via malicious update payloads.

/// Managed state for the daemon child process.
pub struct DaemonState(pub Mutex<Option<CommandChild>>);

/// Gracefully stop the daemon process (SIGTERM on Unix, kill on Windows).
/// Sends the signal but does NOT take the child from state, so the monitor task
/// can detect the exit and clean up properly. The caller should poll
/// `daemon_running()` or the state to confirm the daemon has exited.
pub fn graceful_stop_daemon(state: &DaemonState) {
    let daemon = state.0.lock().unwrap_or_else(|e| {
        eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in graceful_stop_daemon, recovering");
        e.into_inner()
    });
    if let Some(ref child) = *daemon {
        let pid = child.pid();
        #[cfg(unix)]
        {
            // Guard: PID must be > 0 to avoid killing the entire process group (PID 0)
            // or all processes (PID -1).
            if (pid as i32) > 0 {
                // SAFETY: libc::kill with a validated positive PID and SIGTERM signal.
                // Mutex is held during kill to prevent PID reuse races.
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            } else {
                eprintln!("[eidolon] WARNING: refusing to send SIGTERM to invalid PID {}", pid);
            }
        }
        #[cfg(windows)]
        {
            // On Windows, we need to take ownership to call kill
            drop(daemon);
            let mut daemon = state.0.lock().unwrap_or_else(|e| {
                eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in graceful_stop_daemon (windows), recovering");
                e.into_inner()
            });
            if let Some(child) = daemon.take() {
                let _ = child.kill();
            }
        }
        let _ = pid; // suppress unused on Windows
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DaemonState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_version,
            commands::open_external_url,
            commands::discover_servers,
            commands::start_daemon,
            commands::stop_daemon,
            commands::daemon_running,
            commands::check_config_exists,
            commands::validate_config,
            commands::get_config_role,
            commands::get_server_gateway_config,
            commands::get_os_username,
            commands::get_config_path,
            commands::onboard_setup_server,
            commands::save_client_config,
            commands::get_client_config,
            commands::setup_claude_token,
            commands::read_claude_token,
            commands::has_claude_token,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide the window on close instead of destroying it.
            // The daemon continues running; use tray "Quit" to fully exit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Eidolon desktop application");
}
