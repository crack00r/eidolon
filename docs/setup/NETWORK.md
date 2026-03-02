# Network & Connectivity Guide

Complete guide for connecting all Eidolon components across devices using Tailscale mesh VPN, with an alternative Cloudflare Tunnel option.

## Network Architecture

All Eidolon components communicate over a Tailscale mesh VPN. This provides encrypted, peer-to-peer connections without exposing any ports to the public internet.

```
                        TAILSCALE MESH (100.x.x.x/8)
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │  Ubuntu Server            Windows PC         MacBook     │
   │  100.64.0.1               100.64.0.2         100.64.0.3 │
   │  ┌──────────────┐        ┌───────────┐      ┌────────┐  │
   │  │ Eidolon Core │        │GPU Worker │      │ Tauri  │  │
   │  │              │◄──────►│ :8420     │      │ Client │  │
   │  │ Gateway      │        └───────────┘      │        │  │
   │  │ :7777        │◄─────────────────────────►│        │  │
   │  │              │                            └────────┘  │
   │  │ Web Dashboard│        iPhone                          │
   │  │ :3000        │        100.64.0.4                      │
   │  │              │        ┌───────────┐                   │
   │  │              │◄──────►│ iOS App   │                   │
   │  └──────────────┘        └───────────┘                   │
   │                                                          │
   └──────────────────────────────────────────────────────────┘
```

### Port Map

| Component | Port | Protocol | Direction |
|---|---|---|---|
| Brain Gateway | 7777 | WebSocket (JSON-RPC 2.0) | Clients → Server |
| GPU Worker | 8420 | HTTP + WebSocket | Server → GPU |
| Web Dashboard | 3000 | HTTP | Browser → Server |
| Telegram API | 443 | HTTPS (outbound) | Server → Telegram |

## Tailscale Setup

### Install Tailscale on All Devices

**Ubuntu Server:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Follow the link to authenticate
```

**Windows PC:**
- Download from [tailscale.com/download](https://tailscale.com/download)
- Install and sign in

**macOS:**
- Install from the [App Store](https://apps.apple.com/app/tailscale/id1475387142) or `brew install tailscale`
- Sign in

**iPhone/iPad:**
- Install from the [App Store](https://apps.apple.com/app/tailscale/id1470499037)
- Sign in with the same account

### Verify Connectivity

On any device:

```bash
tailscale status
# 100.64.0.1  ubuntu-server  user@...  linux   -
# 100.64.0.2  windows-pc     user@...  windows -
# 100.64.0.3  macbook        user@...  macOS   -
# 100.64.0.4  iphone         user@...  iOS     -
```

Test connectivity between the server and each device:

```bash
# From any device
ping ubuntu-server.tailnet.ts.net
```

### Tailscale ACLs (Access Control)

Configure ACLs in the [Tailscale Admin Console](https://login.tailscale.com/admin/acls) to restrict which devices can reach Eidolon services:

```jsonc
{
  "acls": [
    // All devices can reach the Eidolon gateway
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["ubuntu-server:7777"]
    },
    // Only the server can reach the GPU worker
    {
      "action": "accept",
      "src": ["ubuntu-server"],
      "dst": ["windows-pc:8420"]
    },
    // All devices can reach the web dashboard
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["ubuntu-server:3000"]
    }
  ]
}
```

This ensures that only the brain server can communicate with the GPU worker, while clients can reach the gateway and web dashboard.

## How Components Connect

### Clients → Brain Server (Gateway)

All clients (desktop, iOS, web) connect to the brain server's WebSocket gateway:

```
Client → ws://ubuntu-server.tailnet.ts.net:7777 → Brain Server
```

1. Client opens WebSocket connection
2. Client sends auth message with gateway token
3. Server validates token (constant-time comparison)
4. On success: bidirectional JSON-RPC 2.0 communication
5. Server sends heartbeats every 30s (configurable)

### Brain Server → GPU Worker

The brain server connects to the GPU worker over HTTP/WebSocket:

```
Brain Server → http://windows-pc.tailnet.ts.net:8420 → GPU Worker
```

1. Brain server performs periodic health checks (every 30s)
2. TTS/STT requests are sent as HTTP POST with `Authorization: Bearer <GPU_API_KEY>`
3. Real-time voice uses WebSocket at `/voice/realtime`
4. Circuit breaker: if 3 consecutive health checks fail, the GPU worker is marked offline and Eidolon falls back to text-only mode

### Brain Server → Telegram

The Telegram bot makes outbound HTTPS connections to the Telegram API:

```
Brain Server → https://api.telegram.org → Telegram
```

This requires outbound internet access (port 443) from the server. No inbound ports needed for polling mode.

## Alternative: Cloudflare Tunnel

If a device cannot join the Tailscale network (e.g., an iPhone on a corporate network), use a Cloudflare Tunnel to expose the gateway.

### Setup on the Server

1. Install `cloudflared`:
   ```bash
   curl -fsSL https://pkg.cloudflare.com/cloudflared-linux-amd64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb
   ```

2. Authenticate with Cloudflare:
   ```bash
   cloudflared tunnel login
   ```

3. Create a tunnel:
   ```bash
   cloudflared tunnel create eidolon
   # Created tunnel eidolon with id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

4. Configure the tunnel (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: eidolon
   credentials-file: /root/.cloudflared/xxxxxxxx.json

   ingress:
     - hostname: eidolon.yourdomain.com
       service: ws://localhost:7777
     - hostname: dashboard.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

5. Create DNS records:
   ```bash
   cloudflared tunnel route dns eidolon eidolon.yourdomain.com
   cloudflared tunnel route dns eidolon dashboard.yourdomain.com
   ```

6. Run the tunnel:
   ```bash
   cloudflared tunnel run eidolon
   ```

7. Install as a system service:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable cloudflared
   sudo systemctl start cloudflared
   ```

### Connect from iOS

In the Eidolon iOS app settings:
- **Server**: `eidolon.yourdomain.com`
- **Port**: `443`
- **Use TLS**: Enabled

The Cloudflare Tunnel handles TLS termination and WebSocket proxying automatically.

> **Security note:** The Cloudflare Tunnel exposes the gateway to the internet (behind Cloudflare's network). Ensure a strong gateway auth token is set. Consider enabling Cloudflare Access for additional authentication.

## Firewall Rules

### Ubuntu Server

```bash
# Allow gateway from Tailscale only
sudo ufw allow in on tailscale0 to any port 7777

# Allow web dashboard from Tailscale only
sudo ufw allow in on tailscale0 to any port 3000

# Block gateway from public interfaces
sudo ufw deny 7777
sudo ufw deny 3000

# Allow outbound (Telegram, package managers, etc.)
# UFW allows all outbound by default

# Verify
sudo ufw status verbose
```

### Windows PC

```powershell
# PowerShell (elevated)
# Allow GPU worker from Tailscale only
New-NetFirewallRule -DisplayName "Eidolon GPU Worker" `
  -Direction Inbound -Protocol TCP -LocalPort 8420 `
  -InterfaceAlias "Tailscale" -Action Allow

# Block GPU worker from other interfaces
New-NetFirewallRule -DisplayName "Eidolon GPU Block" `
  -Direction Inbound -Protocol TCP -LocalPort 8420 `
  -Action Block
```

### macOS

No firewall changes needed — the desktop client only makes outbound connections.

## TLS Configuration

### Option 1: Tailscale (Recommended)

Tailscale encrypts all traffic between nodes using WireGuard. No additional TLS configuration is needed for intra-Tailscale communication.

The gateway listens on plain `ws://` and Tailscale handles encryption at the network layer.

### Option 2: Tailscale HTTPS Certificates

Tailscale can provision Let's Encrypt certificates for your Tailscale hostnames:

```bash
# On the server
tailscale cert ubuntu-server.tailnet.ts.net
# Created: ubuntu-server.tailnet.ts.net.crt
# Created: ubuntu-server.tailnet.ts.net.key
```

Configure the gateway to use TLS:

```jsonc
{
  "gateway": {
    "tls": {
      "enabled": true,
      "certPath": "/path/to/ubuntu-server.tailnet.ts.net.crt",
      "keyPath": "/path/to/ubuntu-server.tailnet.ts.net.key"
    }
  }
}
```

Clients connect via `wss://ubuntu-server.tailnet.ts.net:7777`.

> **Note:** Tailscale certs auto-renew, but you may need to restart the daemon or set up a renewal hook.

### Option 3: Self-Signed Certificates

For testing only. Not recommended for production.

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=ubuntu-server"
```

Clients must trust the self-signed certificate manually.

### Option 4: Let's Encrypt (via Cloudflare Tunnel)

When using a Cloudflare Tunnel, TLS is handled by Cloudflare automatically. No certificate management needed on the server.

## Testing Connectivity

### Full Connectivity Check

Run from the brain server:

```bash
eidolon doctor
# ✓ Tailscale connected (100.64.0.1)
# ✓ Gateway port 7777 available
# ✓ GPU worker reachable (windows-pc.tailnet.ts.net:8420)
# ✓ Telegram API reachable
```

### Manual Tests

**Server → GPU Worker:**
```bash
curl -H "Authorization: Bearer $GPU_API_KEY" \
  http://windows-pc.tailnet.ts.net:8420/health
```

**Client → Gateway:**
```bash
# Using websocat
websocat ws://ubuntu-server.tailnet.ts.net:7777
```

**Server → Telegram:**
```bash
curl https://api.telegram.org/bot<TOKEN>/getMe
```

**Latency Check:**
```bash
# Measure round-trip to GPU worker
time curl -s http://windows-pc.tailnet.ts.net:8420/health > /dev/null
```

## Troubleshooting

### Tailscale nodes not visible

- Ensure all devices are logged in to the same Tailscale account (or shared via Tailscale sharing)
- Check Tailscale status: `tailscale status`
- Restart Tailscale: `sudo systemctl restart tailscaled` (Linux) or restart the app

### Connection refused

- Verify the service is running on the target port
- Check firewall rules on the target machine
- Ensure you are using the Tailscale IP/hostname, not the LAN IP

### High latency between nodes

- Tailscale prefers direct connections but falls back to DERP relays
- Check if connections are direct: `tailscale status` (look for "direct" vs "relay")
- Ensure both nodes can establish direct UDP connections (no strict NAT)
- If behind corporate NAT, DERP relay latency is typically 50-150ms

### iOS app cannot connect via Tailscale

- Ensure Tailscale VPN is active on the iPhone (check the VPN icon in status bar)
- iOS may disconnect Tailscale in the background — open the Tailscale app to reconnect
- Consider the Cloudflare Tunnel alternative for more reliable iOS connectivity

### WebSocket disconnects frequently

- Check `gateway.heartbeatInterval` in config (default: 30000ms)
- Mobile connections may have higher latency — increase heartbeat timeout
- Check server logs for disconnection reasons

## Next Steps

- [Server Setup](SERVER.md) — brain server configuration
- [GPU Worker Setup](GPU_WORKER.md) — GPU worker on Windows
- [Desktop Client](DESKTOP.md) — Tauri desktop app
- [iOS Client](IOS.md) — iPhone/iPad app
- [Telegram Bot](TELEGRAM.md) — Telegram channel
- [Web Dashboard](WEB.md) — browser-based dashboard
