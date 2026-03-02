use serde::Serialize;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

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
