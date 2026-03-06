# Running Eidolon as a Windows Service (P1-70)

> Last updated: 2026-03-06. For Windows 10/11 with Bun installed.

Eidolon is primarily designed for Linux (systemd). To run it as a Windows service, use NSSM (Non-Sucking Service Manager) or the built-in `sc.exe`.

## Option 1: NSSM (Recommended)

NSSM is a lightweight service wrapper that handles process management, logging, and restart on failure.

### Installation

```powershell
# Install via Chocolatey
choco install nssm

# Or download manually from https://nssm.cc/download
# Extract nssm.exe to a directory in your PATH (e.g., C:\tools\nssm\)
```

### Setup

```powershell
# Install the service
nssm install Eidolon "C:\Users\<user>\.bun\bin\bun.exe" "run" "C:\eidolon\packages\cli\src\index.ts" "daemon" "start" "--foreground"

# Set the working directory
nssm set Eidolon AppDirectory "C:\eidolon"

# Set environment variables
nssm set Eidolon AppEnvironmentExtra ^
  "EIDOLON_CONFIG=C:\eidolon\eidolon.json" ^
  "EIDOLON_DATA_DIR=C:\ProgramData\eidolon" ^
  "EIDOLON_LOG_DIR=C:\ProgramData\eidolon\logs"

# Configure stdout/stderr logging
nssm set Eidolon AppStdout "C:\ProgramData\eidolon\logs\service-stdout.log"
nssm set Eidolon AppStderr "C:\ProgramData\eidolon\logs\service-stderr.log"
nssm set Eidolon AppStdoutCreationDisposition 4
nssm set Eidolon AppStderrCreationDisposition 4
nssm set Eidolon AppRotateFiles 1
nssm set Eidolon AppRotateBytes 10485760

# Configure restart behavior
nssm set Eidolon AppRestartDelay 5000
nssm set Eidolon AppThrottle 30000

# Configure shutdown
nssm set Eidolon AppStopMethodSkip 0
nssm set Eidolon AppStopMethodConsole 5000
nssm set Eidolon AppStopMethodWindow 5000
nssm set Eidolon AppStopMethodThreads 5000

# Set service to start automatically
nssm set Eidolon Start SERVICE_AUTO_START

# Set description
nssm set Eidolon Description "Eidolon AI Assistant Daemon"

# Set display name
nssm set Eidolon DisplayName "Eidolon AI Assistant"
```

### Service Management

```powershell
# Start the service
nssm start Eidolon

# Stop the service
nssm stop Eidolon

# Restart the service
nssm restart Eidolon

# Check service status
nssm status Eidolon

# View service configuration
nssm edit Eidolon    # Opens GUI editor

# Remove the service
nssm remove Eidolon confirm
```

## Option 2: sc.exe (Built-in, Advanced)

Using Windows' built-in `sc.exe` requires a service wrapper since Bun is not a native Windows service.

### Using WinSW (Windows Service Wrapper)

[WinSW](https://github.com/winsw/winsw) converts any executable into a Windows service.

1. Download `WinSW-x64.exe` from the [releases page](https://github.com/winsw/winsw/releases).
2. Rename it to `eidolon-service.exe`.
3. Place it in `C:\eidolon\`.
4. Create `eidolon-service.xml` in the same directory:

```xml
<service>
  <id>Eidolon</id>
  <name>Eidolon AI Assistant</name>
  <description>Eidolon autonomous AI assistant daemon</description>
  <executable>C:\Users\%USERNAME%\.bun\bin\bun.exe</executable>
  <arguments>run C:\eidolon\packages\cli\src\index.ts daemon start --foreground</arguments>
  <workingdirectory>C:\eidolon</workingdirectory>
  <logpath>C:\ProgramData\eidolon\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <env name="EIDOLON_CONFIG" value="C:\eidolon\eidolon.json"/>
  <env name="EIDOLON_DATA_DIR" value="C:\ProgramData\eidolon"/>
  <env name="EIDOLON_LOG_DIR" value="C:\ProgramData\eidolon\logs"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stopparentprocessfirst>true</stopparentprocessfirst>
</service>
```

5. Install and manage the service:

```powershell
# Install (run as Administrator)
.\eidolon-service.exe install

# Start
.\eidolon-service.exe start

# Stop
.\eidolon-service.exe stop

# Check status
.\eidolon-service.exe status

# Uninstall
.\eidolon-service.exe uninstall
```

## Directory Structure

```
C:\eidolon\                       # Application directory
  packages\                       # Monorepo packages
  eidolon.json                    # Configuration
  eidolon-service.exe             # WinSW wrapper (if using Option 2)
  eidolon-service.xml             # WinSW config (if using Option 2)

C:\ProgramData\eidolon\           # Data directory
  data\
    memory.db
    operational.db
    audit.db
  logs\
    daemon.log
    service-stdout.log
    service-stderr.log
  secrets.db
  backups\
```

## Firewall Configuration

If other devices on the Tailscale network need to reach the Eidolon gateway:

```powershell
# Allow inbound on gateway port (default 8419)
netsh advfirewall firewall add rule name="Eidolon Gateway" dir=in action=allow protocol=TCP localport=8419

# Allow inbound for discovery beacons (UDP 41920)
netsh advfirewall firewall add rule name="Eidolon Discovery" dir=in action=allow protocol=UDP localport=41920
```

## Troubleshooting

### Service fails to start

1. Check that Bun is installed and in the system PATH:
   ```powershell
   bun --version
   ```
2. Verify the config file is valid:
   ```powershell
   bun run C:\eidolon\packages\cli\src\index.ts config validate
   ```
3. Check service logs in `C:\ProgramData\eidolon\logs\`
4. Try running the command manually first:
   ```powershell
   cd C:\eidolon
   set EIDOLON_CONFIG=C:\eidolon\eidolon.json
   bun run packages\cli\src\index.ts daemon start --foreground
   ```

### Service starts but crashes immediately

1. Ensure the data directory exists and is writable:
   ```powershell
   mkdir C:\ProgramData\eidolon\data
   mkdir C:\ProgramData\eidolon\logs
   ```
2. Run `eidolon doctor` to check prerequisites:
   ```powershell
   bun run C:\eidolon\packages\cli\src\index.ts doctor
   ```

### Permission issues

If running as the SYSTEM account (default for services), the service may not have access to user-specific paths:
- Claude Code CLI must be installed system-wide, not per-user
- Bun must be accessible from the SYSTEM PATH
- Consider running the service as a specific user account instead:
  ```powershell
  nssm set Eidolon ObjectName ".\eidolon-user" "password"
  ```

## Comparison with Linux (systemd)

| Feature | systemd (Linux) | NSSM (Windows) | WinSW (Windows) |
|---|---|---|---|
| Auto-restart on crash | Yes (Restart=on-failure) | Yes (AppRestartDelay) | Yes (onfailure) |
| Log rotation | Yes (journald) | Yes (AppRotateFiles) | Yes (roll-by-size) |
| Delayed start | Yes (After=network-online.target) | No | Yes (delayedAutoStart) |
| Security hardening | Yes (NoNewPrivileges, ProtectSystem) | No | No |
| Process monitoring | systemctl status | nssm status | winsw status |
| Graceful shutdown | SIGTERM + TimeoutStopSec | Console + Window + Thread | stopparentprocessfirst |
