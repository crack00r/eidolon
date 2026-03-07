mod commands;
mod tray;

use std::process::Child;
use std::sync::Mutex;
use tauri::Manager;

// SECURITY: The updater pubkey in tauri.conf.json MUST be replaced with a real Ed25519
// public key before any production release. Generate a key pair with:
//   cargo tauri signer generate -w ~/.tauri/eidolon.key
// Then set the pubkey field to the generated public key string.
// An empty or placeholder pubkey disables update signature verification, allowing
// arbitrary code execution via malicious update payloads.

/// Managed state for the daemon child process.
pub struct DaemonState(pub Mutex<Option<Child>>);

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
            commands::get_config_role,
            commands::get_os_username,
            commands::get_config_path,
            commands::run_bun_script,
            commands::onboard_setup_server,
            commands::save_client_config,
            commands::get_client_config,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<DaemonState>() {
                    if let Ok(mut daemon) = state.0.lock() {
                        if let Some(mut child) = daemon.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Eidolon desktop application");
}
