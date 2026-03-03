# Windows Setup Guide

This guide covers two Windows use cases:

1. **GPU Worker** -- Running the TTS/STT GPU worker on a Windows PC with an NVIDIA GPU (e.g., RTX 5080).
2. **Desktop Client** -- Installing the Tauri desktop app for chatting, memory browsing, and voice mode.

Optionally, you can also run the full Eidolon daemon on Windows, though the primary deployment target is Ubuntu.

Tested on Windows 10 (22H2) and Windows 11 (23H2).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Desktop App (Client Only)](#desktop-app-client-only)
3. [GPU Worker Setup](#gpu-worker-setup)
4. [Full Daemon Setup (Optional)](#full-daemon-setup-optional)
5. [Tailscale for Windows](#tailscale-for-windows)
6. [Running as a Service](#running-as-a-service)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Use Case | Check |
|---|---|---|
| Windows 10/11 | All | `winver` |
| Tailscale | Connecting to server | `tailscale version` |
| NVIDIA GPU + Drivers | GPU Worker | `nvidia-smi` |
| Docker Desktop + NVIDIA Toolkit | GPU Worker (Docker) | `docker info` |
| Python 3.11+ | GPU Worker (Native) | `python --version` |
| Bun | Daemon/Development | `bun --version` |
| pnpm | Daemon/Development | `pnpm --version` |

## Desktop App (Client Only)

### Install from GitHub Releases

1. Go to the [Eidolon Releases page](https://github.com/crack00r/eidolon/releases).
2. Download `Eidolon-x64.msi` (Windows installer).
3. Run the installer. Follow the prompts.
4. Launch Eidolon from the Start Menu.

### Connect to Your Server

1. Open Eidolon.
2. Go to **Settings**.
3. Enter your server connection details:
   - **Host**: Your server's Tailscale IP or hostname (e.g., `100.64.0.1` or `ubuntu-server.tailnet.ts.net`)
   - **Port**: `8419`
   - **Token**: The gateway token configured on the server
4. Click **Connect**.

The desktop app communicates with the Eidolon daemon over WebSocket. All processing happens on the server.

## GPU Worker Setup

The GPU worker runs Qwen3-TTS (text-to-speech) and faster-whisper (speech-to-text) on your NVIDIA GPU. It is a Python/FastAPI service that the Eidolon core daemon communicates with over HTTP.

### Option A: Docker (Recommended)

Docker is the cleanest way to run the GPU worker. It avoids Python dependency conflicts.

#### Install Docker Desktop

1. Download [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/).
2. During installation, enable **WSL 2 backend**.
3. Restart your computer.

#### Install NVIDIA Container Toolkit

In a PowerShell terminal with Administrator privileges:

```powershell
# Install the NVIDIA Container Toolkit via WSL2
wsl --install  # if WSL is not already set up

# In WSL2 (Ubuntu):
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

Verify GPU access in Docker:

```powershell
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

You should see your GPU listed.

#### Run the GPU Worker

```powershell
# Clone the repo (if not already done)
git clone https://github.com/crack00r/eidolon.git
cd eidolon\services\gpu-worker

# Set the GPU worker authentication token
# Use the same token you set on the Eidolon server with:
#   bun packages/cli/src/index.ts secrets set GPU_WORKER_TOKEN
$env:EIDOLON_GPU_API_KEY = "your-gpu-worker-token-here"

# Build and start
docker compose up -d
```

Verify the worker is running:

```powershell
curl http://localhost:8420/health
```

Expected response:

```json
{
  "status": "ok",
  "gpu": {
    "name": "NVIDIA GeForce RTX 5080",
    "vram_total_mb": 16384,
    "vram_used_mb": 3400,
    "temperature_c": 45,
    "utilization_pct": 0
  }
}
```

#### Docker Commands

```powershell
docker compose up -d        # Start in background
docker compose logs -f      # Follow logs
docker compose down         # Stop
docker compose up -d --build  # Rebuild after code changes
```

### Option B: Native Python (No Docker)

If you prefer running without Docker:

#### Install Python

1. Download Python 3.11+ from [python.org](https://www.python.org/downloads/).
2. During installation, check **Add Python to PATH**.
3. Verify: `python --version`

#### Install CUDA Toolkit

1. Download the [CUDA Toolkit](https://developer.nvidia.com/cuda-downloads) (version 12.4+).
2. Install with default options.
3. Verify: `nvcc --version`

#### Set Up the GPU Worker

```powershell
cd eidolon\services\gpu-worker

# Create a virtual environment
python -m venv .venv
.venv\Scripts\Activate.ps1

# Install dependencies
pip install ".[gpu]"

# Set the authentication token
$env:EIDOLON_GPU_API_KEY = "your-gpu-worker-token-here"

# Start the worker
uvicorn src.main:app --host 0.0.0.0 --port 8420
```

The first start will download the TTS and STT models (several GB). Subsequent starts are fast.

### Configure the Eidolon Server

On your Ubuntu server (or wherever the Eidolon daemon runs), add the GPU worker to the config:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "windows-rtx5080",
        "host": "windows-pc.tailnet.ts.net",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt", "realtime"]
      }
    ],
    "tts": {
      "model": "Qwen/Qwen3-TTS-1.7B",
      "defaultSpeaker": "Aiden",
      "sampleRate": 24000
    },
    "stt": {
      "model": "large-v3",
      "language": "auto"
    }
  }
}
```

Ensure the `GPU_WORKER_TOKEN` secret on the server matches the `EIDOLON_GPU_API_KEY` set on the Windows machine.

## Full Daemon Setup (Optional)

You can run the Eidolon daemon on Windows. This is not the primary deployment target, but it works for single-machine setups.

### Install Bun

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# Restart your terminal
bun --version
```

### Install pnpm

```powershell
npm install -g pnpm
pnpm --version
```

### Clone and Build

```powershell
git clone https://github.com/crack00r/eidolon.git C:\eidolon
cd C:\eidolon
pnpm install
pnpm -r build
```

### Configure

Create the config directory and file:

```powershell
mkdir $env:APPDATA\eidolon -Force
```

Create `%APPDATA%\eidolon\eidolon.json` with your configuration. See the [Configuration Reference](../reference/CONFIGURATION.md) for the full schema.

Minimal example:

```json
{
  "identity": {
    "ownerName": "YourName"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "primary",
        "credential": "oauth",
        "priority": 100
      }
    ]
  }
}
```

### Set the Master Key

```powershell
# Generate a random key
$masterKey = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
[Environment]::SetEnvironmentVariable("EIDOLON_MASTER_KEY", $masterKey, "User")

# Display it -- save this in a password manager
Write-Host "Master Key: $masterKey"

# Restart your terminal for the variable to take effect
```

### Run

```powershell
cd C:\eidolon
bun packages/cli/src/index.ts doctor
bun packages/cli/src/index.ts daemon start --foreground
```

## Tailscale for Windows

### Install

Download from [tailscale.com/download](https://tailscale.com/download/windows) or via winget:

```powershell
winget install Tailscale.Tailscale
```

### Configure

1. Launch Tailscale from the system tray.
2. Sign in with the same account used on your other devices.
3. Verify connectivity:

```powershell
tailscale status
tailscale ping ubuntu-server
```

### Firewall

Windows Firewall should automatically allow Tailscale traffic. If the Eidolon server cannot reach port 8420 on your Windows PC:

```powershell
# Allow inbound TCP on port 8420 from Tailscale
New-NetFirewallRule -DisplayName "Eidolon GPU Worker" `
  -Direction Inbound -Protocol TCP -LocalPort 8420 `
  -RemoteAddress 100.64.0.0/10 -Action Allow
```

## Running as a Service

### Option A: Windows Task Scheduler (Included)

The repository includes PowerShell scripts for service management.

#### Install

```powershell
# Run from an elevated (Administrator) PowerShell
cd C:\eidolon\deploy\windows
powershell -ExecutionPolicy Bypass -File install-service.ps1 -MasterKey "your_hex_master_key"
```

This creates a scheduled task named `EidolonDaemon` that starts at user login.

#### Commands

```powershell
schtasks /run /tn EidolonDaemon     # Start now
schtasks /end /tn EidolonDaemon     # Stop
schtasks /query /tn EidolonDaemon   # Check status
```

#### Uninstall

```powershell
cd C:\eidolon\deploy\windows
powershell -ExecutionPolicy Bypass -File uninstall-service.ps1 -RemoveMasterKey
```

### Option B: NSSM (Non-Sucking Service Manager)

For a proper Windows service that runs at boot without user login:

```powershell
# Install NSSM
winget install nssm

# Create the service
nssm install EidolonDaemon "C:\Users\YourUser\.bun\bin\bun.exe" "packages/cli/src/index.ts daemon start --foreground"
nssm set EidolonDaemon AppDirectory "C:\eidolon"
nssm set EidolonDaemon AppEnvironmentExtra "EIDOLON_MASTER_KEY=your_hex_master_key"
nssm set EidolonDaemon DisplayName "Eidolon AI Assistant"
nssm set EidolonDaemon Description "Eidolon autonomous AI daemon"
nssm set EidolonDaemon Start SERVICE_AUTO_START
nssm set EidolonDaemon AppStdout "C:\eidolon\logs\stdout.log"
nssm set EidolonDaemon AppStderr "C:\eidolon\logs\stderr.log"

# Start the service
nssm start EidolonDaemon
```

#### NSSM Commands

```powershell
nssm start EidolonDaemon    # Start
nssm stop EidolonDaemon     # Stop
nssm restart EidolonDaemon  # Restart
nssm status EidolonDaemon   # Check status
nssm edit EidolonDaemon     # Edit configuration (GUI)
nssm remove EidolonDaemon   # Uninstall
```

## Troubleshooting

### GPU Worker: "CUDA not available"

1. Verify NVIDIA drivers are installed: `nvidia-smi`
2. For Docker: ensure NVIDIA Container Toolkit is installed and Docker Desktop has "Use the WSL 2 based engine" enabled.
3. For native Python: ensure CUDA Toolkit version matches your PyTorch version. Check with `python -c "import torch; print(torch.cuda.is_available())"`.

### GPU Worker: Out of VRAM

The default model configuration uses:
- Qwen3-TTS 1.7B: ~3.4 GB VRAM (bfloat16)
- faster-whisper Large v3: ~1.5 GB VRAM (int8)
- Total: ~4.9 GB

If your GPU has less than 6 GB VRAM, use smaller models:

```json
{
  "gpu": {
    "stt": {
      "model": "medium"
    }
  }
}
```

Close other GPU-intensive applications (games, video editing) before running the worker.

### Docker: "Error response from daemon: could not select device driver"

The NVIDIA Container Toolkit is not installed or not configured. Follow the Docker + NVIDIA setup steps above.

### Bun: "not recognized as an internal or external command"

Bun may not be in your PATH. Try:

```powershell
# Find Bun's location
Get-Command bun -ErrorAction SilentlyContinue

# If not found, add to PATH
$bunPath = "$env:USERPROFILE\.bun\bin"
[Environment]::SetEnvironmentVariable("PATH", "$env:PATH;$bunPath", "User")
```

Restart your terminal after modifying PATH.

### Tailscale: Cannot Reach Server

```powershell
tailscale status           # Check connection
tailscale ping ubuntu-server  # Test specific device
Test-NetConnection ubuntu-server.tailnet.ts.net -Port 8419  # Test port
```

If `Test-NetConnection` fails:
- Check the server's firewall allows connections from Tailscale.
- Ensure the Eidolon daemon is running on the server: `curl http://ubuntu-server:8419/health`
- Verify Tailscale ACLs allow the connection.

### Windows Defender Blocking Eidolon

Windows Defender may flag Bun or the Eidolon desktop app. Add exclusions:

1. Open **Windows Security > Virus & threat protection > Manage settings**.
2. Scroll to **Exclusions > Add or remove exclusions**.
3. Add folder exclusions for:
   - `C:\eidolon` (if running the daemon)
   - `%USERPROFILE%\.bun` (Bun runtime)

### Scheduled Task Not Running

```powershell
# Check task status
schtasks /query /tn EidolonDaemon /fo LIST /v

# Check the Event Viewer for errors
Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 20 |
  Where-Object { $_.Message -like '*Eidolon*' } |
  Format-Table TimeCreated, Message -AutoSize
```

### Port 8420 Already in Use

```powershell
netstat -aon | findstr :8420
# Find the PID and kill the process, or change the port in docker-compose.yml
```
