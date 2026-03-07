use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::State;

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
        let socket = UdpSocket::bind("0.0.0.0:41920").map_err(|e| {
            format!(
                "Failed to bind UDP port 41920: {}. Another instance may be listening.",
                e
            )
        })?;

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

                            let server = DiscoveredServer {
                                service: "eidolon".to_string(),
                                version: json
                                    .get("version")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string(),
                                host,
                                port,
                                hostname: json
                                    .get("hostname")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string(),
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
pub fn start_daemon(state: State<DaemonState>, config_path: String) -> Result<u32, String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if daemon.is_some() {
        return Err("Daemon already running".into());
    }

    let mut args = vec![
        "run".to_string(),
        "packages/cli/src/index.ts".to_string(),
        "daemon".to_string(),
        "start".to_string(),
        "--foreground".to_string(),
    ];
    if !config_path.is_empty() {
        args.push("--config".to_string());
        args.push(config_path);
    }

    let child = Command::new("bun")
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to start daemon: {}", e))?;

    let pid = child.id();
    *daemon = Some(child);
    Ok(pid)
}

#[tauri::command]
pub fn stop_daemon(state: State<DaemonState>) -> Result<(), String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = daemon.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to stop daemon: {}", e))?;
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn daemon_running(state: State<DaemonState>) -> bool {
    let daemon = state.0.lock().unwrap_or_else(|e| e.into_inner());
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

#[tauri::command]
pub async fn run_bun_script(script: String) -> Result<String, String> {
    let output = Command::new("bun")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Bun execution failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Script failed: {}", stderr));
    }

    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_client_config(host: String, port: u16, token: String) -> Result<(), String> {
    let config_path = get_config_path_internal();

    // Create parent directory if it doesn't exist
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let config = serde_json::json!({
        "role": "client",
        "server": {
            "host": host,
            "port": port,
            "token": token,
            "tls": false
        }
    });

    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write config: {}", e))?;

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
    api_key: Option<String>,
) -> Result<String, String> {
    let _master_key = random_hex(32); // 64 hex chars
    let token = random_hex(16); // 32 hex chars
    let tailscale_ip = detect_tailscale_ip();

    let (data_dir, log_dir) = get_platform_dirs();

    // Ensure data and log directories exist
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log dir: {}", e))?;

    // Build credential object
    let cred_value = api_key.unwrap_or_else(|| "oauth".to_string());
    let credential = serde_json::json!({
        "type": credential_type,
        "name": "primary",
        "credential": cred_value
    });

    let config = serde_json::json!({
        "role": "server",
        "identity": {
            "name": "Eidolon",
            "ownerName": name
        },
        "gateway": {
            "port": 8419,
            "auth": { "type": "none" },
            "tls": { "enabled": false }
        },
        "database": {
            "directory": data_dir,
            "walMode": true
        },
        "logging": {
            "level": "info",
            "format": "pretty",
            "directory": log_dir,
            "maxSizeMb": 50,
            "maxFiles": 10
        },
        "brain": {
            "claudeAccounts": [credential]
        }
    });

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

    let result = serde_json::json!({
        "ok": true,
        "configPath": config_path,
        "tailscaleIp": tailscale_ip,
        "token": token
    });

    Ok(result.to_string())
}
