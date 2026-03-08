use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::DaemonState;

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

#[derive(Serialize, Clone)]
pub struct DiscoveredServer {
    pub service: String,
    pub version: String,
    pub host: String,
    pub port: u16,
    pub hostname: String,
    pub name: String,
    #[serde(rename = "tailscaleIp", skip_serializing_if = "Option::is_none")]
    pub tailscale_ip: Option<String>,
    pub tls: bool,
}

#[tauri::command]
pub fn get_platform() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Validate URL scheme
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!(
            "Blocked URL scheme. Only http:// and https:// are allowed."
        ));
    }
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(&url, None)
        .map_err(|e| format!("Failed to open URL: {}", e))
}

/// Listen for UDP broadcast beacons on port 41920 for the given timeout.
/// Returns a list of unique discovered servers (deduplicated by host:port).
#[tauri::command]
pub async fn discover_servers(timeout_ms: u64) -> Result<Vec<DiscoveredServer>, String> {
    // Cap timeout to 10 seconds to prevent abuse
    let timeout = Duration::from_millis(timeout_ms.min(10_000));

    // Run the blocking UDP listener on a separate thread
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<DiscoveredServer>, String> {
        let socket = match UdpSocket::bind("0.0.0.0:41920") {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                // Port already in use (co-located server). Return empty list instead of crashing.
                return Ok(Vec::new());
            }
            Err(e) => {
                return Err(format!(
                    "Failed to bind UDP port 41920: {}.",
                    e
                ));
            }
        };

        // Allow address reuse so the server's own socket doesn't conflict
        socket
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| format!("Failed to set socket timeout: {}", e))?;

        let start = Instant::now();
        let mut buf = [0u8; 2048];
        let mut seen: HashMap<String, DiscoveredServer> = HashMap::new();

        while start.elapsed() < timeout {
            match socket.recv_from(&mut buf) {
                Ok((len, addr)) => {
                    if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
                            // Validate it's an eidolon beacon
                            if json.get("service").and_then(|v| v.as_str()) != Some("eidolon") {
                                continue;
                            }

                            let host = json
                                .get("host")
                                .and_then(|v| v.as_str())
                                .unwrap_or_else(|| {
                                    // Fall back to the source IP
                                    // We can't return &str from addr directly, so use a default
                                    "unknown"
                                })
                                .to_string();

                            let host = if host == "unknown" {
                                addr.ip().to_string()
                            } else {
                                host
                            };

                            let port = json
                                .get("port")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(8419) as u16;

                            let key = format!("{}:{}", host, port);
                            if seen.contains_key(&key) {
                                continue;
                            }

                            let hostname = json
                                .get("hostname")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();

                            let server = DiscoveredServer {
                                service: "eidolon".to_string(),
                                version: json
                                    .get("version")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string(),
                                host,
                                port,
                                name: hostname.clone(),
                                hostname,
                                tailscale_ip: json
                                    .get("tailscaleIp")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string()),
                                tls: json
                                    .get("tls")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false),
                            };

                            seen.insert(key, server);
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Timeout on recv — just loop and check overall timeout
                    continue;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    continue;
                }
                Err(e) => {
                    return Err(format!("UDP recv error: {}", e));
                }
            }
        }

        Ok(seen.into_values().collect())
    })
    .await
    .map_err(|e| format!("Discovery task failed: {}", e))?;

    result
}

// ---------------------------------------------------------------------------
// Daemon lifecycle commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_daemon(
    app: tauri::AppHandle,
    state: State<DaemonState>,
    config_path: String,
) -> Result<u32, String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if daemon.is_some() {
        return Err("Daemon already running".into());
    }

    let mut args: Vec<String> = vec![
        "daemon".to_string(),
        "start".to_string(),
        "--foreground".to_string(),
    ];
    if !config_path.is_empty() {
        args.push("--config".to_string());
        args.push(config_path);
    }

    // Read master key and pass as environment variable if available
    let mut env_vars: Vec<(String, String)> = Vec::new();
    if let Some(key) = read_master_key() {
        env_vars.push(("EIDOLON_MASTER_KEY".to_string(), key));
    }

    let mut sidecar_command = app
        .shell()
        .sidecar("eidolon-cli")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(&args);

    for (k, v) in &env_vars {
        sidecar_command = sidecar_command.env(k, v);
    }

    let (rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    let pid = child.pid();
    *daemon = Some(child);

    // Spawn task to monitor daemon output and exit
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::mpsc::Receiver;
        let mut rx: Receiver<CommandEvent> = rx;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let _ = app_handle.emit("daemon-log", text.to_string());
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let _ = app_handle.emit("daemon-error", text.to_string());
                }
                CommandEvent::Terminated(status) => {
                    let exit_payload = serde_json::json!({
                        "code": status.code,
                        "signal": status.signal,
                        "message": match (status.code, status.signal) {
                            (Some(c), _) => format!("Process exited with code {}", c),
                            (_, Some(s)) => format!("Process killed by signal {}", s),
                            _ => "Process terminated".to_string(),
                        }
                    });
                    let _ = app_handle.emit("daemon-exit", exit_payload);
                    // Clear the daemon state so daemon_running() returns false
                    if let Some(state) = app_handle.try_state::<DaemonState>() {
                        if let Ok(mut daemon) = state.0.lock() {
                            *daemon = None;
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(pid)
}

#[tauri::command]
pub fn stop_daemon(state: State<DaemonState>) -> Result<(), String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = daemon.take() {
        let pid = child.pid();
        // Send SIGTERM for graceful shutdown on Unix, SIGKILL on Windows
        #[cfg(unix)]
        {
            // SAFETY: libc::kill with a valid PID and SIGTERM signal
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        {
            child
                .kill()
                .map_err(|e| format!("Failed to stop daemon: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn daemon_running(state: State<DaemonState>) -> bool {
    let daemon = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // With the event monitor task (FIX 3), state is cleared on process exit,
    // so is_some() accurately reflects whether the daemon is running.
    daemon.is_some()
}

// ---------------------------------------------------------------------------
// Onboarding commands
// ---------------------------------------------------------------------------

/// Return the platform-specific config file path.
fn get_config_path_internal() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "macos") {
        format!("{}/Library/Preferences/eidolon/eidolon.json", home)
    } else if cfg!(target_os = "windows") {
        format!(
            "{}/eidolon/config/eidolon.json",
            std::env::var("APPDATA").unwrap_or_default()
        )
    } else {
        format!("{}/.config/eidolon/eidolon.json", home)
    }
}

#[tauri::command]
pub async fn check_config_exists() -> bool {
    let config_path = get_config_path_internal();
    std::path::Path::new(&config_path).exists()
}

#[tauri::command]
pub async fn get_config_role() -> Result<String, String> {
    let config_path = get_config_path_internal();
    let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(json
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("server")
        .to_string())
}

#[tauri::command]
pub async fn get_os_username() -> String {
    whoami::username()
}

#[tauri::command]
pub async fn get_config_path() -> String {
    get_config_path_internal()
}

/// Set restrictive file permissions on Unix (0o600 = owner read/write only).
fn set_config_permissions(path: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    // On Windows, file permissions are handled by ACLs; no action needed.
    #[cfg(not(unix))]
    {
        let _ = path; // suppress unused warning
    }
}

/// Build the complete skeleton config sections that both server and client configs share.
/// This matches the structure produced by `buildServerConfig()` and `buildClientConfig()`
/// in `packages/core/src/onboarding/setup-finalize.ts`.
fn build_skeleton_sections() -> serde_json::Value {
    serde_json::json!({
        "loop": { "energyBudget": { "categories": {} }, "rest": {}, "businessHours": {} },
        "memory": {
            "extraction": {},
            "dreaming": {},
            "search": {},
            "embedding": {},
            "retention": {},
            "entityResolution": {}
        },
        "learning": { "relevance": {}, "autoImplement": {}, "budget": {} },
        "channels": {},
        "gpu": { "tts": {}, "stt": {}, "fallback": {} },
        "security": { "policies": {}, "approval": {}, "sandbox": {}, "audit": {} },
        "logging": {},
        "daemon": {}
    })
}

#[tauri::command]
pub async fn save_client_config(host: String, port: u16, token: String, tls: bool) -> Result<(), String> {
    let config_path = get_config_path_internal();

    // Create parent directory if it doesn't exist
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    // Build the complete client config matching buildClientConfig() in setup-finalize.ts
    let skeleton = build_skeleton_sections();
    let skeleton_obj = skeleton.as_object().unwrap();

    let mut config = serde_json::json!({
        "role": "client",
        "server": {
            "host": host,
            "port": port,
            "token": token,
            "tls": tls
        },
        "identity": { "name": "Eidolon", "ownerName": "Client" },
        "brain": {
            "accounts": [{ "type": "oauth", "name": "primary", "credential": "oauth" }],
            "model": {},
            "session": {}
        },
        "gateway": { "auth": { "type": "none" } },
        "database": {}
    });

    // Merge skeleton sections into config
    if let Some(config_obj) = config.as_object_mut() {
        for (key, value) in skeleton_obj {
            config_obj.insert(key.clone(), value.clone());
        }
    }

    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write config: {}", e))?;

    set_config_permissions(&config_path);

    Ok(())
}

#[derive(Serialize)]
pub struct ClientConfig {
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub tls: Option<bool>,
}

#[tauri::command]
pub async fn get_client_config() -> Result<ClientConfig, String> {
    let config_path = get_config_path_internal();
    let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let server = json.get("server").ok_or("No server section in config")?;

    Ok(ClientConfig {
        host: server
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string(),
        port: server
            .get("port")
            .and_then(|v| v.as_u64())
            .unwrap_or(8419) as u16,
        token: server
            .get("token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        tls: server.get("tls").and_then(|v| v.as_bool()),
    })
}

/// Return the platform-specific path for the master key file.
fn get_master_key_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "macos") {
        format!("{}/Library/Preferences/eidolon/master.key", home)
    } else if cfg!(target_os = "windows") {
        format!(
            "{}/eidolon/config/master.key",
            std::env::var("APPDATA").unwrap_or_default()
        )
    } else {
        format!("{}/.config/eidolon/master.key", home)
    }
}

/// Read the persisted master key, if it exists.
fn read_master_key() -> Option<String> {
    let path = get_master_key_path();
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Persist the master key to disk with restrictive permissions (0600).
fn persist_master_key(key: &str) -> Result<(), String> {
    let path = get_master_key_path();
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create master key dir: {}", e))?;
    }
    std::fs::write(&path, key).map_err(|e| format!("Failed to write master key: {}", e))?;
    set_config_permissions(&path);
    Ok(())
}

/// Try to detect a non-loopback local IPv4 address. Falls back to "127.0.0.1".
fn detect_local_ip() -> String {
    // Connect a UDP socket to a public address to determine the local interface IP.
    // No data is actually sent.
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

/// Generate a random hex string of the given byte length (output is 2x bytes in hex chars).
fn random_hex(byte_len: usize) -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..byte_len).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Try to detect the Tailscale IPv4 address. Returns None if unavailable.
fn detect_tailscale_ip() -> Option<String> {
    Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Return platform-appropriate (data_dir, log_dir) for Eidolon.
fn get_platform_dirs() -> (String, String) {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "macos") {
        (
            format!("{}/Library/Application Support/eidolon", home),
            format!("{}/Library/Logs/eidolon", home),
        )
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        (
            format!("{}/eidolon/data", appdata),
            format!("{}/eidolon/logs", appdata),
        )
    } else {
        (
            format!("{}/.local/share/eidolon", home),
            format!("{}/.local/share/eidolon/logs", home),
        )
    }
}

#[tauri::command]
pub async fn onboard_setup_server(
    name: String,
    credential_type: String,
    _api_key: Option<String>,
) -> Result<String, String> {
    let master_key = random_hex(32); // 64 hex chars
    let token = random_hex(16); // 32 hex chars
    let tailscale_ip = detect_tailscale_ip();

    // Persist master key with restrictive permissions
    persist_master_key(&master_key)?;

    let (data_dir, _log_dir) = get_platform_dirs();

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    // Build credential object.
    // For api-key type, use a $secret reference so resolveSecretRefs() can resolve it.
    // For oauth type, use a plain string credential.
    let credential = if credential_type == "api-key" {
        serde_json::json!({
            "type": credential_type,
            "name": "primary",
            "credential": { "$secret": "claude-api-key" }
        })
    } else {
        serde_json::json!({
            "type": credential_type,
            "name": "primary",
            "credential": "oauth"
        })
    };

    // Build the skeleton sections matching buildServerConfig() in setup-finalize.ts
    let skeleton = build_skeleton_sections();
    let skeleton_obj = skeleton.as_object().unwrap();

    let mut config = serde_json::json!({
        "role": "server",
        "identity": {
            "name": "Eidolon",
            "ownerName": name
        },
        "brain": {
            "accounts": [credential],
            "model": {},
            "session": {}
        },
        "gateway": {
            "host": "0.0.0.0",
            "port": 8419,
            "auth": { "type": "token", "token": token },
            "tls": { "enabled": false }
        },
        "database": {
            "directory": data_dir
        }
    });

    // Merge skeleton sections into config
    if let Some(config_obj) = config.as_object_mut() {
        for (key, value) in skeleton_obj {
            config_obj.insert(key.clone(), value.clone());
        }
    }

    // Write config file
    let config_path = get_config_path_internal();
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("Failed to write config: {}", e))?;

    set_config_permissions(&config_path);

    let host = tailscale_ip
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(detect_local_ip);

    let result = serde_json::json!({
        "ok": true,
        "configPath": config_path,
        "host": host,
        "port": 8419,
        "token": token,
        "tailscaleIp": tailscale_ip
    });

    Ok(result.to_string())
}
