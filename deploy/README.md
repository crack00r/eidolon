# Deployment Guide

Eidolon runs on Linux, macOS, and Windows. This directory contains OS-specific service configuration files.

## Prerequisites (all platforms)

1. [Bun](https://bun.sh) installed and on PATH
2. Eidolon installed: `pnpm install && pnpm -r build`
3. Configuration file created: `eidolon config validate`
4. At least one Claude account configured in `eidolon.json`

## Quick Start (any OS)

The simplest way to run the daemon on any platform:

```bash
# Foreground (for testing)
eidolon daemon start --foreground

# Background (detaches from terminal)
eidolon daemon start

# Check status
eidolon daemon status

# Stop
eidolon daemon stop
```

For production use, install as an OS-level service so it starts automatically and restarts on failure.

---

## Linux (systemd)

**Files:** `eidolon.service`, `eidolon-backup.service`, `eidolon-backup.timer`

### Install

```bash
# Copy service files
sudo cp deploy/eidolon.service /etc/systemd/system/
sudo cp deploy/eidolon-backup.service /etc/systemd/system/
sudo cp deploy/eidolon-backup.timer /etc/systemd/system/

# Create the eidolon system user (optional, for isolation)
sudo useradd --system --create-home --home-dir /var/lib/eidolon eidolon

# Create directories
sudo mkdir -p /var/lib/eidolon /var/log/eidolon /etc/eidolon
sudo chown eidolon:eidolon /var/lib/eidolon /var/log/eidolon

# Copy config (adjust paths in the file as needed)
sudo cp ~/.config/eidolon/eidolon.json /etc/eidolon/eidolon.json

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable eidolon.service
sudo systemctl start eidolon.service

# Enable daily backup timer
sudo systemctl enable eidolon-backup.timer
sudo systemctl start eidolon-backup.timer
```

### Manage

```bash
sudo systemctl status eidolon
sudo systemctl stop eidolon
sudo systemctl restart eidolon
sudo journalctl -u eidolon -f    # follow logs
```

### Uninstall

```bash
sudo systemctl stop eidolon
sudo systemctl disable eidolon
sudo rm /etc/systemd/system/eidolon.service
sudo rm /etc/systemd/system/eidolon-backup.service
sudo rm /etc/systemd/system/eidolon-backup.timer
sudo systemctl daemon-reload
```

### Running as your own user (no root)

If you prefer not to create a system user, edit `eidolon.service`:

- Remove the `User=` and `Group=` lines
- Change `ReadWritePaths` to your home directory
- Place the service file in `~/.config/systemd/user/` instead
- Use `systemctl --user enable eidolon` and `systemctl --user start eidolon`

### Default paths (Linux)

| Purpose    | Path                              |
|------------|-----------------------------------|
| Data/DBs   | `~/.local/share/eidolon/`         |
| Config     | `~/.config/eidolon/eidolon.json`  |
| Logs       | `~/.local/state/eidolon/logs/`    |
| Cache      | `~/.cache/eidolon/`               |

Override with: `EIDOLON_DATA_DIR`, `EIDOLON_CONFIG_DIR`, `EIDOLON_LOG_DIR`, `EIDOLON_CACHE_DIR`

---

## macOS (launchd)

**File:** `com.eidolon.daemon.plist`

### Install

```bash
# Edit the plist: replace REPLACE_WITH_USERNAME with your macOS username
sed "s/REPLACE_WITH_USERNAME/$(whoami)/g" deploy/com.eidolon.daemon.plist > ~/Library/LaunchAgents/com.eidolon.daemon.plist

# Verify the bun path matches your installation:
#   Homebrew Apple Silicon: /opt/homebrew/bin/bun
#   Homebrew Intel:         /usr/local/bin/bun
#   Direct install:         ~/.bun/bin/bun
# Edit ProgramArguments in the plist if needed.

# Create log directory
mkdir -p ~/Library/Logs/eidolon

# Load (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Manage

```bash
# Check status
launchctl list | grep eidolon

# Stop
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist

# Start
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist

# View logs
tail -f ~/Library/Logs/eidolon/stdout.log
```

### Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist
rm ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Default paths (macOS)

| Purpose    | Path                                              |
|------------|---------------------------------------------------|
| Data/DBs   | `~/Library/Application Support/eidolon/`          |
| Config     | `~/Library/Preferences/eidolon/eidolon.json`      |
| Logs       | `~/Library/Logs/eidolon/`                         |
| Cache      | `~/Library/Caches/eidolon/`                       |

Override with: `EIDOLON_DATA_DIR`, `EIDOLON_CONFIG_DIR`, `EIDOLON_LOG_DIR`, `EIDOLON_CACHE_DIR`

---

## Windows

**File:** `eidolon-windows.ps1`

Two options: NSSM-based Windows service (recommended) or Task Scheduler (simpler, no admin).

### Option A: NSSM Windows Service (recommended)

NSSM provides proper service lifecycle, automatic restart, and log rotation.

```powershell
# 1. Download NSSM from https://nssm.cc/download and add to PATH

# 2. Open PowerShell as Administrator

# 3. Install the service
.\deploy\eidolon-windows.ps1 install

# 4. Start
.\deploy\eidolon-windows.ps1 start

# 5. Check status
.\deploy\eidolon-windows.ps1 status
```

Manage via PowerShell or `services.msc`:

```powershell
.\deploy\eidolon-windows.ps1 stop
.\deploy\eidolon-windows.ps1 start
.\deploy\eidolon-windows.ps1 status
.\deploy\eidolon-windows.ps1 uninstall
```

### Option B: Task Scheduler (no admin required)

```powershell
# Install (starts at login)
.\deploy\eidolon-windows.ps1 install-task

# Start now
schtasks /run /tn EidolonDaemon

# Remove
.\deploy\eidolon-windows.ps1 uninstall-task
```

### Default paths (Windows)

| Purpose    | Path                                   |
|------------|----------------------------------------|
| Data/DBs   | `%APPDATA%\eidolon\`                  |
| Config     | `%APPDATA%\eidolon\config\`           |
| Logs       | `%APPDATA%\eidolon\logs\`             |
| Cache      | `%LOCALAPPDATA%\eidolon\cache\`       |

Override with: `EIDOLON_DATA_DIR`, `EIDOLON_CONFIG_DIR`, `EIDOLON_LOG_DIR`, `EIDOLON_CACHE_DIR`

---

## Environment Variables (all platforms)

| Variable              | Description                    | Default               |
|-----------------------|--------------------------------|-----------------------|
| `EIDOLON_DATA_DIR`    | Database and state directory   | Platform-specific     |
| `EIDOLON_CONFIG_DIR`  | Configuration directory        | Platform-specific     |
| `EIDOLON_CONFIG`      | Config file path               | `<config_dir>/eidolon.json` |
| `EIDOLON_LOG_DIR`     | Log file directory             | Platform-specific     |
| `EIDOLON_CACHE_DIR`   | Cache directory                | Platform-specific     |
| `EIDOLON_MASTER_KEY`  | Master key for encrypted secrets | (none, uses keychain) |

## Files in this directory

| File                         | Platform | Purpose                                      |
|------------------------------|----------|----------------------------------------------|
| `eidolon.service`            | Linux    | systemd service unit                          |
| `eidolon-backup.service`     | Linux    | systemd oneshot for daily backup              |
| `eidolon-backup.timer`       | Linux    | systemd timer triggering daily backup at 03:00|
| `com.eidolon.daemon.plist`   | macOS    | launchd LaunchAgent (per-user)                |
| `eidolon-windows.ps1`        | Windows  | PowerShell script for NSSM service or Task Scheduler |
