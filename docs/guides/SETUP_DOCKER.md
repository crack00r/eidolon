# Docker Setup Guide

This guide covers deploying Eidolon using Docker. Two components can be containerized:

1. **Core Daemon** -- The Eidolon brain (TypeScript + Bun).
2. **GPU Worker** -- The TTS/STT service (Python + CUDA).

These can run on the same machine or on different machines connected via Tailscale.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [GPU Worker (Docker)](#gpu-worker-docker)
3. [Core Daemon (Docker)](#core-daemon-docker)
4. [Full Stack with Docker Compose](#full-stack-with-docker-compose)
5. [Volume Management](#volume-management)
6. [Environment Variables](#environment-variables)
7. [Networking](#networking)
8. [Monitoring and Logs](#monitoring-and-logs)
9. [Backup and Restore](#backup-and-restore)
10. [Updating](#updating)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Docker Engine | 24+ | `docker --version` |
| Docker Compose | v2+ | `docker compose version` |
| NVIDIA Drivers | 535+ (for GPU) | `nvidia-smi` |
| NVIDIA Container Toolkit | Latest (for GPU) | `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` |

### Install Docker

Follow the official instructions for your platform:
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
- [Docker Desktop for macOS](https://docs.docker.com/desktop/install/mac-install/)

### Install NVIDIA Container Toolkit (GPU only)

Required only if running the GPU worker:

```bash
# Add NVIDIA container toolkit repository
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## GPU Worker (Docker)

The GPU worker is a standalone service. It runs independently of the core daemon and communicates over HTTP.

### Build and Run

```bash
cd services/gpu-worker

# Set the authentication token
export EIDOLON_GPU_API_KEY="your-strong-random-token"

# Build and start
docker compose up -d --build
```

### Verify

```bash
# Health check
curl -H "Authorization: Bearer $EIDOLON_GPU_API_KEY" http://localhost:8420/health

# Test TTS (returns audio bytes)
curl -X POST \
  -H "Authorization: Bearer $EIDOLON_GPU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from Eidolon.", "language": "en", "speaker": "Aiden"}' \
  http://localhost:8420/tts/generate \
  --output test.wav
```

### GPU Worker docker-compose.yml

The file at `services/gpu-worker/docker-compose.yml` is already configured:

```yaml
services:
  gpu-worker:
    build:
      context: .
      dockerfile: Dockerfile.cuda
    ports:
      - "127.0.0.1:8420:8420"
    environment:
      - EIDOLON_GPU_API_KEY=${EIDOLON_GPU_API_KEY:?Must be set}
    security_opt:
      - "no-new-privileges:true"
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: "16g"
    pids_limit: 256
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8420/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped
```

To expose the worker to the Tailscale network (so other machines can reach it), change the port binding:

```yaml
    ports:
      - "0.0.0.0:8420:8420"   # accessible from all interfaces
```

Only do this on a Tailscale-connected machine with proper firewall rules. Never expose port 8420 to the public internet.

## Core Daemon (Docker)

The core daemon can also run in Docker, though native installation on Ubuntu (see [Ubuntu Setup Guide](SETUP_UBUNTU.md)) is recommended for production.

### Dockerfile for Core

Create a `Dockerfile` in the repository root:

```dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/test-utils/package.json packages/test-utils/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy source code
COPY packages/ packages/
COPY tsconfig.base.json ./

# Build
RUN pnpm -r build

# Create non-root user
RUN addgroup -S eidolon && adduser -S eidolon -G eidolon
RUN mkdir -p /data /config /logs && chown -R eidolon:eidolon /data /config /logs
USER eidolon

# Default environment
ENV EIDOLON_DATA_DIR=/data
ENV EIDOLON_LOG_DIR=/logs
ENV EIDOLON_CONFIG=/config/eidolon.json

EXPOSE 8419

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8419/health || exit 1

CMD ["bun", "packages/cli/src/index.ts", "daemon", "start", "--foreground"]
```

### Build and Run the Core

```bash
# Build the image
docker build -t eidolon-core .

# Create volumes for persistent data
docker volume create eidolon-data
docker volume create eidolon-config
docker volume create eidolon-logs

# Run
docker run -d \
  --name eidolon \
  -p 8419:8419 \
  -v eidolon-data:/data \
  -v eidolon-config:/config \
  -v eidolon-logs:/logs \
  -e EIDOLON_MASTER_KEY="your_hex_master_key" \
  --restart unless-stopped \
  eidolon-core
```

### Prepare Configuration

Before starting the container, copy your configuration into the volume:

```bash
# Copy config file into the volume
docker cp /path/to/eidolon.json eidolon:/config/eidolon.json

# Or mount a host directory instead of a volume:
docker run -d \
  --name eidolon \
  -p 8419:8419 \
  -v /etc/eidolon:/config:ro \
  -v /var/lib/eidolon:/data \
  -v /var/log/eidolon:/logs \
  -e EIDOLON_MASTER_KEY="your_hex_master_key" \
  --restart unless-stopped \
  eidolon-core
```

## Full Stack with Docker Compose

To run both the core daemon and GPU worker together, create a `docker-compose.yml` in the repository root:

```yaml
services:
  core:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8419:8419"
    volumes:
      - eidolon-data:/data
      - eidolon-logs:/logs
      - ./eidolon.json:/config/eidolon.json:ro
    environment:
      - EIDOLON_MASTER_KEY=${EIDOLON_MASTER_KEY:?Must be set}
      - EIDOLON_CONFIG=/config/eidolon.json
      - EIDOLON_DATA_DIR=/data
      - EIDOLON_LOG_DIR=/logs
    security_opt:
      - "no-new-privileges:true"
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8419/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped
    depends_on:
      gpu-worker:
        condition: service_healthy

  gpu-worker:
    build:
      context: ./services/gpu-worker
      dockerfile: Dockerfile.cuda
    ports:
      - "127.0.0.1:8420:8420"
    environment:
      - EIDOLON_GPU_API_KEY=${EIDOLON_GPU_API_KEY:?Must be set}
    security_opt:
      - "no-new-privileges:true"
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: "16g"
    pids_limit: 256
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8420/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  eidolon-data:
  eidolon-logs:
```

### Start the Full Stack

```bash
# Create a .env file with your secrets
cat > .env << EOF
EIDOLON_MASTER_KEY=your_hex_master_key
EIDOLON_GPU_API_KEY=your_gpu_worker_token
EOF
chmod 600 .env

# Start everything
docker compose up -d

# View logs
docker compose logs -f

# Check status
docker compose ps
```

### Without a GPU

If your machine does not have a GPU, remove the `gpu-worker` service and the `depends_on` from `core`:

```yaml
services:
  core:
    # ... same as above, but remove depends_on
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8419:8419"
    volumes:
      - eidolon-data:/data
      - eidolon-logs:/logs
      - ./eidolon.json:/config/eidolon.json:ro
    environment:
      - EIDOLON_MASTER_KEY=${EIDOLON_MASTER_KEY:?Must be set}
    restart: unless-stopped

volumes:
  eidolon-data:
  eidolon-logs:
```

Eidolon will fall back to CPU-based TTS or text-only mode.

## Volume Management

### Data Persistence

All persistent state is stored in Docker volumes or bind mounts:

| Container Path | Purpose | Volume/Mount |
|---|---|---|
| `/data` | SQLite databases (memory.db, operational.db, audit.db) | `eidolon-data` |
| `/config` | Configuration file (eidolon.json) | Bind mount or `eidolon-config` |
| `/logs` | Log files | `eidolon-logs` |

### Inspect Volumes

```bash
# List volumes
docker volume ls | grep eidolon

# Inspect a volume
docker volume inspect eidolon-data

# View volume contents
docker run --rm -v eidolon-data:/data alpine ls -la /data
```

### Volume Location on Host

By default, Docker volumes are stored at `/var/lib/docker/volumes/`. To use a specific host directory instead:

```yaml
volumes:
  - /var/lib/eidolon:/data          # host path : container path
  - /etc/eidolon:/config:ro         # read-only config
  - /var/log/eidolon:/logs
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `EIDOLON_MASTER_KEY` | Yes | Hex-encoded encryption key for secrets |
| `EIDOLON_CONFIG` | No | Config file path (default: `/config/eidolon.json`) |
| `EIDOLON_DATA_DIR` | No | Data directory (default: `/data`) |
| `EIDOLON_LOG_DIR` | No | Log directory (default: `/logs`) |
| `EIDOLON_GPU_API_KEY` | GPU only | Authentication token for GPU worker |
| `EIDOLON_LOGGING_LEVEL` | No | Override log level (`debug`, `info`, `warn`, `error`) |

Never put secrets directly in `docker-compose.yml`. Use a `.env` file (and add it to `.gitignore`) or Docker secrets.

### Using Docker Secrets (Swarm Mode)

For production deployments using Docker Swarm:

```yaml
services:
  core:
    # ...
    secrets:
      - eidolon_master_key
    environment:
      - EIDOLON_MASTER_KEY_FILE=/run/secrets/eidolon_master_key

secrets:
  eidolon_master_key:
    external: true
```

## Networking

### Same Machine

When both containers run on the same Docker host, they communicate via the Docker network. The core can reach the GPU worker at `gpu-worker:8420`.

Update the Eidolon config to use the Docker service name:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "local-gpu",
        "host": "gpu-worker",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt"]
      }
    ]
  }
}
```

### Separate Machines

When the core and GPU worker run on different machines (e.g., core on Ubuntu, GPU on Windows), they communicate over Tailscale. Configure the GPU worker's Tailscale hostname:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "windows-rtx5080",
        "host": "windows-pc.tailnet.ts.net",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt"]
      }
    ]
  }
}
```

### Exposing to Tailscale

To make the core daemon accessible to Tailscale clients, bind to all interfaces:

```yaml
    ports:
      - "0.0.0.0:8419:8419"
```

Ensure your host firewall only allows Tailscale traffic to this port.

## Monitoring and Logs

### View Logs

```bash
# All services
docker compose logs -f

# Core only
docker compose logs -f core

# GPU worker only
docker compose logs -f gpu-worker

# Last 100 lines
docker compose logs --tail 100 core
```

### Health Checks

```bash
# Core health
curl http://localhost:8419/health

# GPU worker health
curl -H "Authorization: Bearer $EIDOLON_GPU_API_KEY" http://localhost:8420/health

# Docker health status
docker compose ps
```

### Resource Usage

```bash
docker stats eidolon-core eidolon-gpu-worker
```

## Backup and Restore

### Backup

Stop the core (to ensure database consistency), copy the data volume, and restart:

```bash
# Stop the core
docker compose stop core

# Backup the data volume
docker run --rm \
  -v eidolon-data:/data:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/eidolon-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restart
docker compose start core
```

For hot backups without downtime (SQLite WAL mode supports this):

```bash
docker exec eidolon bun packages/cli/src/index.ts backup run
```

### Restore

```bash
docker compose stop core

# Restore from backup
docker run --rm \
  -v eidolon-data:/data \
  -v $(pwd)/backups:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/eidolon-backup-YYYYMMDD.tar.gz -C /data"

docker compose start core
```

## Updating

### Pull Latest Code and Rebuild

```bash
git pull origin main

# Rebuild images
docker compose build

# Restart with new images
docker compose up -d

# Verify
docker compose ps
docker compose logs --tail 20
```

### Zero-Downtime Update (Rolling)

If you need minimal downtime:

```bash
# Build new images without stopping
docker compose build

# Recreate containers one at a time
docker compose up -d --no-deps core
docker compose up -d --no-deps gpu-worker
```

## Troubleshooting

### Container Exits Immediately

```bash
docker compose logs core
```

Common causes:
- `EIDOLON_MASTER_KEY` not set: check your `.env` file.
- Config file not found: ensure the volume mount is correct.
- Port already in use: check with `ss -tlnp | grep 8419`.

### GPU Not Detected in Container

```bash
# Test GPU access
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi

# If this fails:
# 1. Check NVIDIA drivers: nvidia-smi (on host)
# 2. Check NVIDIA Container Toolkit: nvidia-ctk --version
# 3. Restart Docker: sudo systemctl restart docker
```

### Database Corruption After Crash

SQLite with WAL mode is resilient to crashes, but if a database becomes corrupted:

```bash
docker compose stop core

# Try to recover
docker run --rm -v eidolon-data:/data alpine sh -c "
  cd /data
  for db in memory.db operational.db audit.db; do
    if [ -f \$db ]; then
      echo 'Checking \$db...'
      sqlite3 \$db 'PRAGMA integrity_check;'
    fi
  done
"

# If integrity check fails, restore from backup (see Backup section)
docker compose start core
```

### "Permission denied" Errors

The container runs as a non-root user (`eidolon`). Ensure volumes have correct permissions:

```bash
docker run --rm -v eidolon-data:/data alpine chown -R 1000:1000 /data
```

### Cannot Reach Health Endpoint

```bash
# Check if the container is running
docker compose ps

# Check which ports are bound
docker port eidolon-core

# Test from inside the container
docker exec eidolon curl -f http://localhost:8419/health
```
