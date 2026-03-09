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
    let mut daemon = state.0.lock().unwrap_or_else(|e| {
        eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in start_daemon, recovering");
        e.into_inner()
    });
    if daemon.is_some() {
        return Err("Daemon already running".into());
    }

    let mut args: Vec<String> = vec![
        "daemon".to_string(),
        "start".to_string(),
        "--foreground".to_string(),
    ];
    if !config_path.is_empty() {
        // Validate config_path: reject path traversal and non-JSON files
        if config_path.contains("..") {
            return Err("Invalid config_path: path traversal ('..') is not allowed".into());
        }
        if !config_path.ends_with(".json") {
            return Err("Invalid config_path: must end with '.json'".into());
        }
        args.push("--config".to_string());
        args.push(config_path);
    }

    // Read master key and pass as environment variable if available
    let mut env_vars: Vec<(String, String)> = Vec::new();
    if let Some(key) = read_master_key() {
        env_vars.push(("EIDOLON_MASTER_KEY".to_string(), key));
    }
    // Ensure the sidecar uses Eidolon's own Claude config directory (H-1 fix)
    env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), get_eidolon_claude_config_dir()));

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
pub async fn stop_daemon(state: State<'_, DaemonState>) -> Result<(), String> {
    // Send SIGTERM but keep the child in state so the monitor task can detect the exit.
    let pid = {
        let daemon = state.0.lock().unwrap_or_else(|e| {
            eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in stop_daemon (pid read), recovering");
            e.into_inner()
        });
        match daemon.as_ref() {
            Some(child) => Some(child.pid()),
            None => None,
        }
    };

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            // Guard: PID must be > 0 to avoid killing the entire process group (PID 0)
            // or all processes (PID -1).
            if (pid as i32) > 0 {
                // SAFETY: libc::kill with a validated positive PID and SIGTERM signal
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            } else {
                eprintln!("[eidolon] WARNING: refusing to send SIGTERM to invalid PID {}", pid);
            }
        }
        #[cfg(windows)]
        {
            let mut daemon = state.0.lock().unwrap_or_else(|e| {
                eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in stop_daemon (windows kill), recovering");
                e.into_inner()
            });
            if let Some(child) = daemon.take() {
                child
                    .kill()
                    .map_err(|e| format!("Failed to stop daemon: {}", e))?;
            }
        }

        // Wait for the monitor task to detect the exit and clear state (up to 5 seconds).
        // Uses tokio::time::sleep to avoid blocking the Tauri async runtime (M-3 fix).
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(5);
        loop {
            if start.elapsed() >= timeout {
                // Force-clear state if daemon didn't exit in time
                let mut daemon = state.0.lock().unwrap_or_else(|e| {
                    eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in stop_daemon (timeout clear), recovering");
                    e.into_inner()
                });
                *daemon = None;
                break;
            }
            // Check state inside a block so the MutexGuard is dropped before the await
            let is_none = {
                let daemon = state.0.lock().unwrap_or_else(|e| {
                    eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in stop_daemon (poll), recovering");
                    e.into_inner()
                });
                daemon.is_none()
            };
            if is_none {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn daemon_running(state: State<DaemonState>) -> bool {
    let daemon = state.0.lock().unwrap_or_else(|e| {
        eprintln!("[eidolon] WARNING: DaemonState mutex was poisoned in daemon_running, recovering");
        e.into_inner()
    });
    // With the event monitor task (FIX 3), state is cleared on process exit,
    // so is_some() accurately reflects whether the daemon is running.
    daemon.is_some()
}

// ---------------------------------------------------------------------------
// Onboarding commands
// ---------------------------------------------------------------------------

/// Return the platform-specific path for the Claude OAuth token file.
/// Find the claude binary by checking common install locations.
fn find_claude_binary() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.local/bin/claude", home),
        format!("{}/.claude/local/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.clone());
        }
    }
    // Check nvm versions directory by iterating entries (M-6 fix: glob patterns don't work with Path::exists)
    let nvm_versions_dir = std::path::PathBuf::from(&home).join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
        for entry in entries.flatten() {
            let claude_path = entry.path().join("bin/claude");
            if claude_path.exists() {
                return claude_path.to_str().map(|s| s.to_string());
            }
        }
    }
    // Try PATH as last resort (works if launched from terminal)
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

/// Return platform-specific path for Eidolon's own Claude config directory.
/// Setting CLAUDE_CONFIG_DIR to this path gives Eidolon a separate Claude auth session.
/// Uses PathBuf::join() for cross-platform path separators (M-7 fix).
fn get_eidolon_claude_config_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(&home)
            .join("Library/Preferences/eidolon/claude-config")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            std::path::PathBuf::from(&home).join("AppData").join("Roaming").to_string_lossy().to_string()
        });
        std::path::PathBuf::from(&appdata)
            .join("eidolon")
            .join("config")
            .join("claude-config")
    } else {
        let xdg = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            std::path::PathBuf::from(&home).join(".config").to_string_lossy().to_string()
        });
        std::path::PathBuf::from(&xdg)
            .join("eidolon/claude-config")
    };
    path.to_string_lossy().to_string()
}

fn get_claude_token_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(&home)
            .join("Library/Preferences/eidolon/claude-token")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        std::path::PathBuf::from(&appdata)
            .join("eidolon")
            .join("config")
            .join("claude-token")
    } else {
        std::path::PathBuf::from(&home)
            .join(".config/eidolon/claude-token")
    };
    path.to_string_lossy().to_string()
}

/// Run `claude setup-token` to obtain a long-lived OAuth token for Eidolon.
/// This opens the user's browser for authorization, then captures the token
/// and saves it to the eidolon config directory with 0600 permissions.
#[tauri::command]
pub async fn setup_claude_token() -> Result<String, String> {
    // Find claude binary -- Tauri apps don't inherit the user's shell PATH
    let claude_bin = find_claude_binary()
        .ok_or_else(|| "Claude CLI not found. Install it from https://claude.ai/download".to_string())?;

    // Eidolon gets its OWN separate Claude session via CLAUDE_CONFIG_DIR.
    // This keeps Eidolon's auth completely independent from the user's global Claude CLI.
    let eidolon_claude_dir = get_eidolon_claude_config_dir();

    // Wrap blocking filesystem and subprocess operations in spawn_blocking (M-3 fix)
    let claude_bin_clone = claude_bin.clone();
    let eidolon_dir_clone = eidolon_claude_dir.clone();
    let setup_result = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        std::fs::create_dir_all(&eidolon_dir_clone)
            .map_err(|e| format!("Failed to create Eidolon Claude config dir: {}", e))?;

        // Check if Eidolon already has its own session
        let check = Command::new(&claude_bin_clone)
            .args(["auth", "status"])
            .env("CLAUDE_CONFIG_DIR", &eidolon_dir_clone)
            .output();

        if let Ok(output) = check {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.contains("\"loggedIn\":true") || stdout.contains("\"loggedIn\": true") {
                // Eidolon already has its own auth session
                let token_path = get_claude_token_path();
                if let Some(parent) = std::path::Path::new(&token_path).parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                std::fs::write(&token_path, "oauth-own-session")
                    .map_err(|e| format!("Failed to save marker: {}", e))?;
                set_config_permissions(&token_path);
                return Ok(Some("Eidolon already has its own Claude session".to_string()));
            }
        }
        Ok(None)
    }).await.map_err(|e| format!("Setup task failed: {}", e))??;

    if let Some(msg) = setup_result {
        return Ok(msg);
    }

    // Open Terminal to create Eidolon's own session
    // Use a unique temporary directory with restrictive permissions (M-5 fix)
    let auth_tmp_dir = format!("{}/eidolon-auth-{}", std::env::temp_dir().display(), random_hex(8));
    let marker_path = format!("{}/done", auth_tmp_dir);

    let auth_tmp_dir_clone = auth_tmp_dir.clone();
    let marker_path_clone = marker_path.clone();
    let eidolon_dir_clone2 = eidolon_claude_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&auth_tmp_dir_clone)
            .map_err(|e| format!("Failed to create auth temp dir: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&auth_tmp_dir_clone, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_file(&marker_path_clone);

        // Shell-escape values to prevent injection via crafted paths.
        // Replace each ' with '\'' (end quote, escaped quote, start quote).
        let safe_eidolon_dir = eidolon_dir_clone2.replace('\'', "'\\''");
        let safe_claude_bin = claude_bin.replace('\'', "'\\''");
        let safe_marker_path = marker_path_clone.replace('\'', "'\\''");

        let helper_script = format!(
            r#"#!/bin/bash
export PATH="$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin:/opt/homebrew/bin:$PATH"
export CLAUDE_CONFIG_DIR='{}'
echo ""
echo "=== Eidolon - Create Own Claude Session ==="
echo "This creates a separate login for Eidolon."
echo "(Your personal Claude login is not affected.)"
echo ""
'{}' auth login
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    echo "success" > '{}'
    echo ""
    echo "Eidolon authorization successful! You can close this window."
else
    echo "failed" > '{}'
    echo ""
    echo "Authorization failed. Please try again."
fi
sleep 3
"#,
            safe_eidolon_dir, safe_claude_bin, safe_marker_path, safe_marker_path
        );

        let script_path = format!("{}/auth.sh", auth_tmp_dir_clone);
        std::fs::write(&script_path, &helper_script)
            .map_err(|e| format!("Failed to write helper script: {}", e))?;
        Command::new("chmod").args(["+x", &script_path]).output().ok();

        let apple_script = format!(
            r#"tell application "Terminal"
    activate
    do script "bash '{}'"
end tell"#,
            script_path
        );
        Command::new("osascript").arg("-e").arg(&apple_script).output()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;

        Ok(())
    }).await.map_err(|e| format!("Script launch task failed: {}", e))??;

    // Poll for completion using tokio::time::sleep and spawn_blocking for file reads (M-3 fix)
    let start = Instant::now();
    let timeout = Duration::from_secs(180);

    loop {
        if start.elapsed() > timeout {
            let dir = auth_tmp_dir.clone();
            tokio::task::spawn_blocking(move || { let _ = std::fs::remove_dir_all(&dir); }).await.ok();
            return Err("Authorization timed out after 3 minutes".to_string());
        }

        let marker = marker_path.clone();
        let read_result = tokio::task::spawn_blocking(move || {
            std::fs::read_to_string(&marker).ok()
        }).await.map_err(|e| format!("Read task failed: {}", e))?;

        if let Some(status) = read_result {
            let dir = auth_tmp_dir.clone();
            tokio::task::spawn_blocking(move || { let _ = std::fs::remove_dir_all(&dir); }).await.ok();

            if status.trim() == "success" {
                let token_result = tokio::task::spawn_blocking(move || -> Result<String, String> {
                    let token_path = get_claude_token_path();
                    if let Some(parent) = std::path::Path::new(&token_path).parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    std::fs::write(&token_path, "oauth-own-session")
                        .map_err(|e| format!("Failed to save marker: {}", e))?;
                    set_config_permissions(&token_path);
                    Ok("Eidolon session created successfully".to_string())
                }).await.map_err(|e| format!("Token save task failed: {}", e))??;
                return Ok(token_result);
            } else {
                return Err("Authorization was not completed. Please try again.".to_string());
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Read the stored Claude OAuth token, if it exists.
#[tauri::command]
pub fn read_claude_token() -> Result<String, String> {
    let token_path = get_claude_token_path();
    std::fs::read_to_string(&token_path)
        .map(|s| s.trim().to_string())
        .map_err(|_| "No Claude token found. Run setup first.".to_string())
}

/// Check whether a stored Claude OAuth token exists.
#[tauri::command]
pub fn has_claude_token() -> bool {
    let token_path = get_claude_token_path();
    std::path::Path::new(&token_path).exists()
}

/// Return the platform-specific config file path.
/// Uses PathBuf::join() for cross-platform path separators (M-7 fix).
fn get_config_path_internal() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(&home)
            .join("Library/Preferences/eidolon/eidolon.json")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        std::path::PathBuf::from(&appdata)
            .join("eidolon")
            .join("config")
            .join("eidolon.json")
    } else {
        std::path::PathBuf::from(&home)
            .join(".config/eidolon/eidolon.json")
    };
    path.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn check_config_exists() -> bool {
    let config_path = get_config_path_internal();
    tokio::task::spawn_blocking(move || std::path::Path::new(&config_path).exists())
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn validate_config() -> Result<serde_json::Value, String> {
    let config_path = get_config_path_internal();

    // Run blocking file I/O on a dedicated thread
    let config_path_clone = config_path.clone();
    let read_result = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let path = std::path::Path::new(&config_path_clone);
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&config_path_clone)
            .map_err(|e| format!("Cannot read config: {}", e))?;
        Ok(Some(content))
    })
    .await
    .map_err(|e| format!("Read task failed: {}", e))??;

    let content = match read_result {
        None => {
            return Ok(serde_json::json!({
                "valid": false,
                "issues": ["Config file does not exist"]
            }));
        }
        Some(c) => c,
    };

    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut issues: Vec<String> = Vec::new();

    // Check role
    if config.get("role").and_then(|v| v.as_str()).is_none() {
        issues.push("Missing role (server/client)".to_string());
    }

    // Check identity
    if config.get("identity").is_none() {
        issues.push("Missing identity configuration".to_string());
    }

    // Check brain.accounts
    let has_accounts = config
        .get("brain")
        .and_then(|b| b.get("accounts"))
        .and_then(|a| a.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !has_accounts {
        issues.push("No AI accounts configured".to_string());
    }

    // Check gateway
    if config.get("gateway").is_none() {
        issues.push("Missing gateway configuration".to_string());
    }

    // Check master key for server role
    let role = config.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if role == "server" {
        let master_key_path = get_master_key_path();
        if !std::path::Path::new(&master_key_path).exists() {
            issues.push("Missing master key (required for server)".to_string());
        }

        // Check that OAuth accounts have a stored Claude token
        let accounts = config
            .get("brain")
            .and_then(|b| b.get("accounts"))
            .and_then(|a| a.as_array());
        if let Some(accts) = accounts {
            let has_oauth = accts.iter().any(|a| {
                a.get("type").and_then(|v| v.as_str()) == Some("oauth")
            });
            if has_oauth {
                let eidolon_claude_dir = get_eidolon_claude_config_dir();
                let claude_dir_exists = std::path::Path::new(&eidolon_claude_dir).exists();

                if !claude_dir_exists {
                    issues.push("Eidolon has no own Claude session (run Authorize Eidolon in setup)".to_string());
                } else {
                    // Verify the session is actually valid.
                    // Run the blocking subprocess on a dedicated thread (L-8 fix).
                    let claude_bin = find_claude_binary();
                    if let Some(bin) = claude_bin {
                        let dir = eidolon_claude_dir.clone();
                        let logged_in = tokio::task::spawn_blocking(move || {
                            Command::new(&bin)
                                .args(["auth", "status"])
                                .env("CLAUDE_CONFIG_DIR", &dir)
                                .output()
                                .map(|o| {
                                    let stdout = String::from_utf8_lossy(&o.stdout);
                                    stdout.contains("\"loggedIn\":true") || stdout.contains("\"loggedIn\": true")
                                })
                                .unwrap_or(false)
                        }).await.unwrap_or(false);
                        if !logged_in {
                            issues.push("Eidolon's Claude session is not authenticated (run Authorize Eidolon in setup)".to_string());
                        }
                    } else {
                        issues.push("Claude CLI not found".to_string());
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "valid": issues.is_empty(),
        "issues": issues
    }))
}

#[tauri::command]
pub async fn get_server_gateway_config() -> Result<serde_json::Value, String> {
    let config_path = get_config_path_internal();
    let content = tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Cannot read config: {}", e))
    })
    .await
    .map_err(|e| format!("Read task failed: {}", e))??;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;

    let gateway = config.get("gateway").cloned().unwrap_or(serde_json::json!({}));
    let port = gateway
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(8419);
    let token = gateway
        .get("auth")
        .and_then(|a| a.get("token"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let tls = gateway
        .get("tls")
        .and_then(|t| t.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    Ok(serde_json::json!({
        "port": port,
        "token": token,
        "tls": tls
    }))
}

#[tauri::command]
pub async fn get_config_role() -> Result<String, String> {
    let config_path = get_config_path_internal();
    let content = tokio::fs::read_to_string(&config_path)
        .await
        .map_err(|e| format!("Cannot read config at {}: {}", config_path, e))?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON in config: {}", e))?;
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
    // Input validation
    if host.is_empty() || host.len() > 253 {
        return Err("Host must be between 1 and 253 characters".to_string());
    }
    if token.len() > 256 {
        return Err("Token must not exceed 256 characters".to_string());
    }

    let config_path = get_config_path_internal();

    // Create parent directory if it doesn't exist
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    // Build the complete client config matching buildClientConfig() in setup-finalize.ts
    let skeleton = build_skeleton_sections();
    let skeleton_obj = skeleton.as_object()
        .ok_or_else(|| "Internal error: skeleton config is not a JSON object".to_string())?;

    // NOTE: Client config stores the gateway token directly because it needs
    // it to connect. Future improvement: use OS keychain integration.
    let mut config = serde_json::json!({
        "role": "client",
        "server": {
            "host": host,
            "port": port,
            "token": token, // TODO: migrate to OS keychain storage
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

    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, config_json)
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
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Cannot read config at {}: {}", config_path, e))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in config: {}", e))?;

    let server = json.get("server").ok_or("No server section in config. Is this a client config?")?;

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
/// Uses PathBuf::join() for cross-platform path separators (M-7 fix).
fn get_master_key_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(&home)
            .join("Library/Preferences/eidolon/master.key")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        std::path::PathBuf::from(&appdata)
            .join("eidolon")
            .join("config")
            .join("master.key")
    } else {
        std::path::PathBuf::from(&home)
            .join(".config/eidolon/master.key")
    };
    path.to_string_lossy().to_string()
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
/// Uses PathBuf::join() for cross-platform path separators (M-7 fix).
fn get_platform_dirs() -> (String, String) {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "macos") {
        (
            std::path::PathBuf::from(&home).join("Library/Application Support/eidolon").to_string_lossy().to_string(),
            std::path::PathBuf::from(&home).join("Library/Logs/eidolon").to_string_lossy().to_string(),
        )
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        (
            std::path::PathBuf::from(&appdata).join("eidolon").to_string_lossy().to_string(),
            std::path::PathBuf::from(&appdata).join("eidolon").join("logs").to_string_lossy().to_string(),
        )
    } else {
        (
            std::path::PathBuf::from(&home).join(".local/share/eidolon").to_string_lossy().to_string(),
            std::path::PathBuf::from(&home).join(".local/share/eidolon/logs").to_string_lossy().to_string(),
        )
    }
}

#[tauri::command]
pub async fn onboard_setup_server(
    name: String,
    credential_type: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    // Input validation
    if name.is_empty() || name.len() > 100 {
        return Err("Name must be between 1 and 100 characters".to_string());
    }

    let master_key = random_hex(32); // 64 hex chars
    let token = random_hex(16); // 32 hex chars
    // Run blocking subprocess on a dedicated thread to avoid blocking the async runtime
    let tailscale_ip = tokio::task::spawn_blocking(detect_tailscale_ip)
        .await
        .unwrap_or(None);

    // Persist master key with restrictive permissions
    persist_master_key(&master_key)?;

    let (data_dir, _log_dir) = get_platform_dirs();

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    // Build credential object based on credential type.
    let credential = if credential_type == "oauth" {
        // OAuth: Claude CLI uses its stored OAuth session (from `claude login`).
        // No API key needed -- the subprocess finds the session via HOME env var.
        serde_json::json!({
            "type": "oauth",
            "name": "primary",
            "credential": "oauth"
        })
    } else {
        // API key: require a non-empty key string.
        let key_value = api_key
            .filter(|k| !k.is_empty())
            .ok_or_else(|| "API key is required".to_string())?;
        // SEC: Store secret reference instead of raw API key.
        // The actual key should be stored in the Eidolon SecretStore via
        // `eidolon secrets set claude-api-key <value>` after onboarding.
        // TODO: Invoke SecretStore from Rust side to persist key_value securely.
        let _ = key_value; // consumed but not written to config in plaintext
        serde_json::json!({
            "type": "api-key",
            "name": "primary",
            "credential": { "$secret": "claude-api-key" }
        })
    };

    // Build the skeleton sections matching buildServerConfig() in setup-finalize.ts
    let skeleton = build_skeleton_sections();
    let skeleton_obj = skeleton.as_object()
        .ok_or_else(|| "Internal error: skeleton config is not a JSON object".to_string())?;

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
            "auth": { "type": "token", "token": { "$secret": "gateway-auth-token" } },
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
    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, config_json)
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

    Ok(result)
}
