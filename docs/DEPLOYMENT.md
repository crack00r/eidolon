# Deployment Guide

Step-by-step instructions for deploying Eidolon in production environments.

## Prerequisites

Before deploying, complete the [Installation Guide](INSTALLATION.md) to verify that Eidolon runs correctly on your system.

## Deployment Options

| Method | Platform | Best For |
|---|---|---|
| [systemd](#systemd-linux) | Ubuntu / Debian / Arch | Headless Linux servers (recommended) |
| [launchd](#launchd-macos) | macOS | Always-on Mac Mini or MacBook |
| [Docker](#docker) | Any | Containerized environments |
| [Manual](#manual-foreground) | Any | Development and testing |

---

## systemd (Linux)

The recommended deployment method for Linux servers.

### 1. Create a system user

```bash
sudo useradd --system --create-home --home-dir /var/lib/eidolon --shell /usr/sbin/nologin eidolon
```

### 2. Install Eidolon

```bash
# Install Bun globally
curl -fsSL https://bun.sh/install | bash

# Install the CLI
npm install -g @eidolon-ai/cli

# Or deploy from source
sudo mkdir -p /opt/eidolon
sudo chown eidolon:eidolon /opt/eidolon
cd /opt/eidolon
sudo -u eidolon git clone https://github.com/crack00r/eidolon.git .
sudo -u eidolon pnpm install
sudo -u eidolon pnpm -r build
```

### 3. Configure

```bash
# Create config directory
sudo mkdir -p /etc/eidolon
sudo chown eidolon:eidolon /etc/eidolon

# Create minimal config
sudo -u eidolon tee /etc/eidolon/eidolon.json <<'EOF'
{
  "identity": {
    "ownerName": "Your Name"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "primary",
        "credential": "oauth"
      }
    ]
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 8419,
    "auth": { "type": "token", "token": { "$secret": "GATEWAY_TOKEN" } }
  },
  "database": {
    "directory": "/var/lib/eidolon/data"
  },
  "logging": {
    "directory": "/var/log/eidolon"
  }
}
EOF

# Create data and log directories
sudo mkdir -p /var/lib/eidolon/data /var/log/eidolon
sudo chown -R eidolon:eidolon /var/lib/eidolon /var/log/eidolon

# Set secrets
sudo -u eidolon EIDOLON_CONFIG=/etc/eidolon/eidolon.json eidolon secrets set GATEWAY_TOKEN
```

### 4. Install the service

```bash
sudo cp deploy/eidolon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable eidolon
sudo systemctl start eidolon
```

### 5. Verify

```bash
# Check service status
sudo systemctl status eidolon

# Check health endpoint
curl http://localhost:8419/health

# View logs
sudo journalctl -u eidolon -f
```

### systemd service file

The service file is located at `deploy/eidolon.service`. Key features:

- **Automatic restart** on failure with 5-second delay
- **Security hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `PrivateDevices`, kernel protections, restricted namespaces
- **Scoped write access**: only `/var/lib/eidolon` and `/var/log/eidolon`
- **Environment variables**: `EIDOLON_CONFIG`, `EIDOLON_DATA_DIR`, `EIDOLON_LOG_DIR`

### Daily backup timer

```bash
# Install the backup timer
sudo cp deploy/eidolon-backup.service /etc/systemd/system/
sudo cp deploy/eidolon-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable eidolon-backup.timer
sudo systemctl start eidolon-backup.timer

# Verify the timer
sudo systemctl list-timers | grep eidolon
```

### Upgrading

```bash
# From source
cd /opt/eidolon
sudo -u eidolon git pull
sudo -u eidolon pnpm install
sudo -u eidolon pnpm -r build
sudo systemctl restart eidolon

# From npm
npm update -g @eidolon-ai/cli
sudo systemctl restart eidolon
```

---

## launchd (macOS)

For running Eidolon as a background service on macOS.

### 1. Install the LaunchAgent

```bash
# Copy the plist
cp deploy/com.eidolon.daemon.plist ~/Library/LaunchAgents/

# Edit: replace REPLACE_WITH_USERNAME with your macOS username
sed -i '' "s/REPLACE_WITH_USERNAME/$(whoami)/g" ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### 2. Create log directory

```bash
mkdir -p ~/Library/Logs/eidolon
```

### 3. Set the master key

Edit the plist to uncomment and set `EIDOLON_MASTER_KEY`, or set it in your shell profile:

```bash
echo 'export EIDOLON_MASTER_KEY="your-master-key"' >> ~/.zshrc
```

### 4. Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### 5. Verify

```bash
# Check status
launchctl list | grep eidolon

# View logs
tail -f ~/Library/Logs/eidolon/stdout.log
tail -f ~/Library/Logs/eidolon/stderr.log

# Check health
curl http://localhost:8419/health
```

### Managing the service

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist

# Start
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Notes

- The plist assumes Homebrew Bun at `/opt/homebrew/bin/bun` (Apple Silicon). For Intel Macs, change to `/usr/local/bin/bun`.
- The service runs as a per-user LaunchAgent, not a system-wide LaunchDaemon.
- Auto-restarts on non-zero exit codes. `ThrottleInterval` of 10 seconds prevents restart loops.

---

## Docker

### Development container

Use the provided `docker-compose.dev.yml` at the repo root for local development:

```bash
docker compose -f docker-compose.dev.yml up
```

This starts the Eidolon daemon with an in-memory configuration suitable for development.

### Production Docker

Create a `Dockerfile` for the production build:

```dockerfile
FROM oven/bun:1.2-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/test-utils/package.json packages/test-utils/
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run --filter '*' build

# Runtime
EXPOSE 8419
VOLUME ["/data", "/config"]

ENV EIDOLON_CONFIG=/config/eidolon.json
ENV EIDOLON_DATA_DIR=/data

CMD ["bun", "run", "packages/cli/src/index.ts", "daemon", "start", "--foreground"]
```

Build and run:

```bash
docker build -t eidolon .
docker run -d \
  --name eidolon \
  -p 8419:8419 \
  -v eidolon-data:/data \
  -v ./eidolon.json:/config/eidolon.json:ro \
  -e EIDOLON_MASTER_KEY="your-key" \
  eidolon
```

---

## GPU Worker Deployment

The GPU worker runs on a machine with an NVIDIA GPU (e.g., Windows PC with RTX 5080).

### Docker (recommended)

```bash
cd services/gpu-worker

# Build the CUDA image
docker build -f Dockerfile.cuda -t eidolon-gpu-worker .

# Run with GPU access
docker run -d \
  --name eidolon-gpu \
  --gpus all \
  -p 8420:8420 \
  -e GPU_WORKER_TOKEN="your-shared-token" \
  eidolon-gpu-worker
```

### Docker Compose

```yaml
# docker-compose.gpu.yml
services:
  gpu-worker:
    build:
      context: services/gpu-worker
      dockerfile: Dockerfile.cuda
    ports:
      - "8420:8420"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      - GPU_WORKER_TOKEN=${GPU_WORKER_TOKEN}
    volumes:
      - gpu-models:/root/.cache/huggingface
    restart: unless-stopped

volumes:
  gpu-models:
```

### Configure Core to use GPU worker

In your `eidolon.json`:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "windows-5080",
        "host": "100.64.0.2",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt"]
      }
    ]
  }
}
```

Set the token on both sides:

```bash
# On the Core server
eidolon secrets set GPU_WORKER_TOKEN

# On the GPU worker (must match)
export GPU_WORKER_TOKEN="same-token-value"
```

---

## Tailscale Mesh Network

Eidolon components communicate over [Tailscale](https://tailscale.com/) for encrypted, zero-config networking.

### Setup

1. Install Tailscale on all devices (server, GPU worker, clients).
2. Join the same tailnet.
3. Use Tailscale hostnames or IPs in configuration:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "windows-5080",
        "host": "windows-pc.tailnet.ts.net",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" }
      }
    ]
  }
}
```

### ACLs (recommended)

Configure Tailscale ACLs to restrict access:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:eidolon-core"],
      "dst": ["tag:eidolon-gpu:8420"]
    },
    {
      "action": "accept",
      "src": ["tag:eidolon-client"],
      "dst": ["tag:eidolon-core:8419"]
    }
  ]
}
```

---

## Backup Strategy

### Automated daily backups

The daemon supports automated SQLite backups via the `database.backupSchedule` config:

```json
{
  "database": {
    "backupPath": "/mnt/backup/eidolon",
    "backupSchedule": "0 3 * * *"
  }
}
```

Backups use SQLite's `.backup()` API for consistent hot copies of all three databases (memory.db, operational.db, audit.db).

### Manual backup

```bash
# Trigger a backup manually
eidolon daemon backup

# Or copy the database files directly (safe with WAL mode)
cp /var/lib/eidolon/data/memory.db /backup/
cp /var/lib/eidolon/data/operational.db /backup/
cp /var/lib/eidolon/data/audit.db /backup/
```

### Restore

```bash
# Stop the daemon
sudo systemctl stop eidolon

# Replace databases
cp /backup/memory.db /var/lib/eidolon/data/
cp /backup/operational.db /var/lib/eidolon/data/
cp /backup/audit.db /var/lib/eidolon/data/
chown eidolon:eidolon /var/lib/eidolon/data/*.db

# Start the daemon
sudo systemctl start eidolon
```

---

## Monitoring

### Health check

```bash
curl http://localhost:8419/health
```

### Prometheus metrics

```bash
curl http://localhost:8419/metrics
```

Metrics include: loop cycle count, active sessions, token usage, event queue depth, connected clients.

### Log monitoring

```bash
# systemd
journalctl -u eidolon -f

# launchd
tail -f ~/Library/Logs/eidolon/stdout.log

# Docker
docker logs -f eidolon
```

### Uptime monitoring

Use an external tool (UptimeRobot, Healthchecks.io) to poll the `/health` endpoint and alert on failures.

---

## Security Checklist

Before exposing Eidolon to the network:

- [ ] Set a strong gateway auth token (`eidolon secrets set GATEWAY_TOKEN`)
- [ ] Enable TLS if exposing beyond localhost
- [ ] Configure `gateway.allowedOrigins` to restrict WebSocket origins
- [ ] Use Tailscale ACLs to limit network access
- [ ] Set GPU worker authentication token
- [ ] Review action security policies in `security.policies`
- [ ] Enable audit logging (`security.audit.enabled: true`)
- [ ] Test backup and restore procedure
- [ ] Set appropriate file permissions (config: 600, data dir: 700)

---

## Troubleshooting

### Service fails to start

```bash
# Check detailed logs
sudo journalctl -u eidolon -n 50 --no-pager

# Common causes:
# - Config validation error (run: eidolon config validate)
# - Port already in use (check: lsof -i :8419)
# - Permission denied on data directory
# - Missing EIDOLON_MASTER_KEY
```

### High memory usage

The embedding model (`multilingual-e5-small`, ~23 MB) loads at startup. This is normal. If memory is limited:

```json
{
  "memory": {
    "embedding": {
      "batchSize": 16
    }
  }
}
```

### Database locked errors

Ensure WAL mode is enabled (default). If you see lock errors:

```json
{
  "database": {
    "walMode": true
  }
}
```

Only one Eidolon process should access the database files at a time. Do not run multiple daemon instances against the same data directory.

### GPU worker unreachable

1. Verify Tailscale connectivity: `ping windows-pc.tailnet.ts.net`
2. Check GPU worker health: `curl http://<gpu-host>:8420/health`
3. Verify token matches on both sides
4. Check firewall rules on the GPU machine
