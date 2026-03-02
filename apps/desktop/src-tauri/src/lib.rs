mod commands;
mod tray;

use tauri::Manager;

// SECURITY: The updater pubkey in tauri.conf.json MUST be replaced with a real Ed25519
// public key before any production release. Generate a key pair with:
//   cargo tauri signer generate -w ~/.tauri/eidolon.key
// Then set the pubkey field to the generated public key string.
// An empty or placeholder pubkey disables update signature verification, allowing
// arbitrary code execution via malicious update payloads.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_version,
            commands::open_external_url,
            commands::discover_servers,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Eidolon desktop application");
}
