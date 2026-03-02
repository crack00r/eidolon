# Web Dashboard Setup

Complete guide for running the Eidolon web dashboard. The dashboard is a SvelteKit application that connects to the brain server's WebSocket gateway.

## Overview

The web dashboard provides a browser-based interface to Eidolon with features similar to the desktop client:

- Chat interface
- Memory browser
- Learning dashboard (view discoveries, approve implementations)
- System status monitoring
- Configuration viewer

It is intended as a lightweight alternative to the desktop client, especially useful for quick access from any device with a browser.

## Running Locally (Development)

### Prerequisites

| Requirement | Version |
|---|---|
| [Node.js](https://nodejs.org/) | 22+ |
| [pnpm](https://pnpm.io/) | 9+ |

### Start the Dev Server

From the repository root:

```bash
pnpm --filter @eidolon/web dev
# > @eidolon/web dev
# > vite dev
#
#   VITE v5.x.x  ready in 500ms
#
#   ➜  Local:   http://localhost:5173/
#   ➜  Network: http://192.168.x.x:5173/
```

Open `http://localhost:5173` in your browser.

### Configure the Gateway Connection

On first visit, you will be prompted to enter:

1. **Server address**: The Tailscale hostname or IP of the brain server
   - Example: `ubuntu-server.tailnet.ts.net` or `100.x.x.y`
2. **Port**: The gateway port (default: `7777`)
3. **Auth token**: The gateway token (same as `GATEWAY_TOKEN` secret on the server)

Connection settings are stored in the browser's `localStorage`.

### Environment Variables

You can pre-configure the gateway connection via environment variables:

```bash
VITE_GATEWAY_HOST=ubuntu-server.tailnet.ts.net \
VITE_GATEWAY_PORT=7777 \
pnpm --filter @eidolon/web dev
```

## Production Build

### Build the Application

```bash
pnpm --filter @eidolon/web build
# Output: apps/web/build/
```

### Serve with Node.js

```bash
cd apps/web
node build/index.js
# Listening on 0.0.0.0:3000
```

Or with environment variables:

```bash
HOST=0.0.0.0 PORT=3000 node build/index.js
```

### Serve with Bun

```bash
cd apps/web
bun build/index.js
# Listening on 0.0.0.0:3000
```

### Serve with PM2 (Process Manager)

```bash
npm install -g pm2

cd apps/web
pm2 start build/index.js --name eidolon-web
pm2 save
pm2 startup    # Configure auto-start on boot
```

## Reverse Proxy Setup

For production, serve the web dashboard behind a reverse proxy with HTTPS.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name eidolon.example.com;

    ssl_certificate /etc/letsencrypt/live/eidolon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eidolon.example.com/privkey.pem;

    # SvelteKit app
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket upgrade for gateway connection
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}

# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name eidolon.example.com;
    return 301 https://$host$request_uri;
}
```

### Caddy

Caddy handles TLS certificates automatically:

```
eidolon.example.com {
    reverse_proxy localhost:3000
}
```

That's it. Caddy auto-provisions a Let's Encrypt certificate.

### Tailscale HTTPS

If you only access the dashboard via Tailscale, you can use Tailscale's built-in HTTPS:

```bash
# Enable HTTPS on the server
tailscale cert ubuntu-server.tailnet.ts.net

# Serve the dashboard with the Tailscale cert
HOST=0.0.0.0 PORT=3000 \
  TLS_CERT=/path/to/ubuntu-server.tailnet.ts.net.crt \
  TLS_KEY=/path/to/ubuntu-server.tailnet.ts.net.key \
  node build/index.js
```

Access via `https://ubuntu-server.tailnet.ts.net:3000`.

## Systemd Service (Optional)

To run the web dashboard as a system service on the same Ubuntu server:

```ini
# /etc/systemd/system/eidolon-web.service
[Unit]
Description=Eidolon Web Dashboard
After=network-online.target eidolon.service
Wants=network-online.target

[Service]
Type=simple
User=eidolon
WorkingDirectory=/opt/eidolon/apps/web
ExecStart=/usr/local/bin/node build/index.js
Environment=HOST=127.0.0.1
Environment=PORT=3000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable eidolon-web
sudo systemctl start eidolon-web
```

## Architecture Notes

The web dashboard does **not** proxy WebSocket connections through SvelteKit. Instead, the browser connects directly to the brain server's gateway:

```
Browser ──WebSocket──> Brain Server :7777 (gateway)
Browser ──HTTP──────> Web Server :3000 (SvelteKit, serves UI)
```

This means:
- The browser must be able to reach the brain server directly (via Tailscale or Cloudflare Tunnel)
- The web server only serves the static UI and handles SSR
- Auth tokens are sent over the WebSocket connection, not through the web server

## Troubleshooting

### Cannot connect to gateway

- Verify the brain server address and port are correct
- Check that the browser can reach the gateway: open browser DevTools > Console, look for WebSocket errors
- If using Tailscale, ensure the browser's machine is on the same Tailscale network
- Try the direct Tailscale IP instead of the hostname

### Build fails

```bash
# Clear build cache and rebuild
pnpm --filter @eidolon/web clean
pnpm --filter @eidolon/web build
```

### WebSocket connection drops frequently

- Check the heartbeat interval in `eidolon.json` (`gateway.heartbeatInterval`)
- If behind a reverse proxy, ensure WebSocket timeouts are configured (see nginx `proxy_read_timeout`)
- Check server logs: `journalctl -u eidolon --since "5 minutes ago"`

### CORS errors

If serving the web dashboard from a different domain than the gateway:
- The gateway does not restrict origins by default within Tailscale
- If using Cloudflare Tunnel, configure the tunnel to allow WebSocket upgrades

### Blank page after build

- Ensure the SvelteKit adapter matches your deployment target
- Check `apps/web/svelte.config.js` for the adapter configuration
- Verify the `build/` directory contains `index.js`

## Next Steps

- [Server Setup](SERVER.md) — set up the brain server
- [Desktop Client](DESKTOP.md) — native desktop alternative
- [Network Guide](NETWORK.md) — Tailscale and connectivity
