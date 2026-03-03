#Requires -Version 5.1
<#
.SYNOPSIS
    Install, start, stop, or remove the Eidolon daemon on Windows.

.DESCRIPTION
    Manages the Eidolon AI Assistant daemon as a Windows service using NSSM
    (Non-Sucking Service Manager), or alternatively as a Task Scheduler task.

    NSSM is recommended because it provides proper service lifecycle management,
    automatic restart on failure, and stdout/stderr logging.

    Download NSSM from: https://nssm.cc/download

.PARAMETER Action
    One of: install, uninstall, start, stop, status, install-task, uninstall-task

.EXAMPLE
    # Install as a Windows service (requires NSSM and admin privileges):
    .\eidolon-windows.ps1 install

    # Start the service:
    .\eidolon-windows.ps1 start

    # Check status:
    .\eidolon-windows.ps1 status

    # Stop the service:
    .\eidolon-windows.ps1 stop

    # Remove the service:
    .\eidolon-windows.ps1 uninstall

    # Alternative: install as a Task Scheduler task (no admin required):
    .\eidolon-windows.ps1 install-task

    # Remove the Task Scheduler task:
    .\eidolon-windows.ps1 uninstall-task
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet("install", "uninstall", "start", "stop", "status", "install-task", "uninstall-task")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Configuration -- adjust these paths for your system
# ---------------------------------------------------------------------------

$ServiceName     = "Eidolon"
$ServiceDisplay   = "Eidolon AI Assistant"
$TaskName        = "EidolonDaemon"
$BunPath         = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
$EidolonDataDir  = Join-Path $env:APPDATA "eidolon"
$EidolonLogDir   = Join-Path $EidolonDataDir "logs"

# Try to find bun in common locations if not on PATH
if (-not $BunPath) {
    $candidates = @(
        (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
        "C:\Program Files\bun\bun.exe",
        (Join-Path $env:LOCALAPPDATA "bun\bun.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $BunPath = $c
            break
        }
    }
}

if (-not $BunPath) {
    Write-Error "bun not found on PATH or in common locations. Install bun first: https://bun.sh"
    exit 1
}

Write-Host "Using bun at: $BunPath"

# Ensure data and log directories exist
if (-not (Test-Path $EidolonDataDir)) { New-Item -ItemType Directory -Path $EidolonDataDir -Force | Out-Null }
if (-not (Test-Path $EidolonLogDir))  { New-Item -ItemType Directory -Path $EidolonLogDir -Force  | Out-Null }

# ---------------------------------------------------------------------------
# NSSM-based Windows Service
# ---------------------------------------------------------------------------

function Find-Nssm {
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssm) { return $nssm.Source }

    $candidates = @(
        "C:\Tools\nssm\nssm.exe",
        "C:\nssm\nssm.exe",
        (Join-Path $env:ProgramFiles "nssm\nssm.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

function Install-EidolonService {
    $nssm = Find-Nssm
    if (-not $nssm) {
        Write-Error @"
NSSM (Non-Sucking Service Manager) not found.
Download it from https://nssm.cc/download and add it to PATH.
Alternatively, use 'install-task' for a Task Scheduler approach (no admin required).
"@
        exit 1
    }

    # Check for admin privileges
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "Installing a Windows service requires administrator privileges. Run PowerShell as Administrator."
        exit 1
    }

    Write-Host "Installing Eidolon as Windows service..."

    & $nssm install $ServiceName $BunPath "run eidolon daemon start --foreground"
    & $nssm set $ServiceName DisplayName $ServiceDisplay
    & $nssm set $ServiceName Description "Eidolon AI Assistant - autonomous personal AI daemon"
    & $nssm set $ServiceName Start SERVICE_AUTO_START
    & $nssm set $ServiceName AppStdout (Join-Path $EidolonLogDir "service-stdout.log")
    & $nssm set $ServiceName AppStderr (Join-Path $EidolonLogDir "service-stderr.log")
    & $nssm set $ServiceName AppRotateFiles 1
    & $nssm set $ServiceName AppRotateBytes 52428800  # 50 MB
    & $nssm set $ServiceName AppStopMethodSkip 0
    & $nssm set $ServiceName AppStopMethodConsole 15000
    & $nssm set $ServiceName AppStopMethodWindow 15000
    & $nssm set $ServiceName AppStopMethodThreads 15000
    & $nssm set $ServiceName AppRestartDelay 5000
    & $nssm set $ServiceName AppExit Default Restart

    # Set environment variables for the service
    & $nssm set $ServiceName AppEnvironmentExtra "EIDOLON_DATA_DIR=$EidolonDataDir" "EIDOLON_LOG_DIR=$EidolonLogDir"

    Write-Host "Service '$ServiceName' installed. Use '.\eidolon-windows.ps1 start' to start it."
}

function Uninstall-EidolonService {
    $nssm = Find-Nssm
    if (-not $nssm) {
        Write-Error "NSSM not found. Cannot uninstall service."
        exit 1
    }

    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "Removing a Windows service requires administrator privileges."
        exit 1
    }

    Write-Host "Stopping and removing Eidolon service..."
    & $nssm stop $ServiceName 2>$null
    & $nssm remove $ServiceName confirm
    Write-Host "Service '$ServiceName' removed."
}

function Start-EidolonService {
    Write-Host "Starting Eidolon service..."
    Start-Service -Name $ServiceName
    Write-Host "Eidolon service started."
}

function Stop-EidolonService {
    Write-Host "Stopping Eidolon service..."
    Stop-Service -Name $ServiceName -Force
    Write-Host "Eidolon service stopped."
}

function Get-EidolonServiceStatus {
    try {
        $svc = Get-Service -Name $ServiceName -ErrorAction Stop
        Write-Host "Eidolon service status: $($svc.Status)"
    } catch {
        # Check PID file as fallback (for non-service usage)
        $pidFile = Join-Path $EidolonDataDir "eidolon.pid"
        if (Test-Path $pidFile) {
            $pid = Get-Content $pidFile -Raw
            $pid = $pid.Trim()
            try {
                $proc = Get-Process -Id $pid -ErrorAction Stop
                Write-Host "Eidolon daemon is running (PID: $pid, not as a service)"
            } catch {
                Write-Host "Eidolon is not running (stale PID file found)"
            }
        } else {
            Write-Host "Eidolon service is not installed and daemon is not running."
        }
    }
}

# ---------------------------------------------------------------------------
# Task Scheduler alternative (no admin required)
# ---------------------------------------------------------------------------

function Install-EidolonTask {
    Write-Host "Creating Task Scheduler task for Eidolon..."

    $action = New-ScheduledTaskAction `
        -Execute $BunPath `
        -Argument "run eidolon daemon start --foreground"

    $trigger = New-ScheduledTaskTrigger -AtLogOn

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 365)

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Eidolon AI Assistant daemon - starts at user login"

    Write-Host "Task '$TaskName' created. It will start automatically on next login."
    Write-Host "To start now: schtasks /run /tn $TaskName"
}

function Uninstall-EidolonTask {
    Write-Host "Removing Task Scheduler task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' removed."
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

switch ($Action) {
    "install"        { Install-EidolonService }
    "uninstall"      { Uninstall-EidolonService }
    "start"          { Start-EidolonService }
    "stop"           { Stop-EidolonService }
    "status"         { Get-EidolonServiceStatus }
    "install-task"   { Install-EidolonTask }
    "uninstall-task" { Uninstall-EidolonTask }
}
