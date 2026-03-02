# Eidolon AI Assistant -- Windows Service Installation
# Installs Eidolon as a scheduled task that runs at user login.
#
# Usage: powershell -ExecutionPolicy Bypass -File install-service.ps1
# Optional: -MasterKey <key> to set the EIDOLON_MASTER_KEY environment variable

param(
    [string]$MasterKey = "",
    [string]$BunPath = "bun",
    [int]$Port = 8419
)

$ErrorActionPreference = "Stop"
$TaskName = "EidolonDaemon"
$Description = "Eidolon AI Assistant Daemon"

Write-Host "=== Eidolon Service Installer ===" -ForegroundColor Cyan
Write-Host ""

# Check if bun is available
try {
    $bunVersion = & $BunPath --version 2>&1
    Write-Host "[OK] Bun runtime: $bunVersion" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Bun runtime not found at '$BunPath'" -ForegroundColor Red
    Write-Host "Install Bun from https://bun.sh or specify -BunPath" -ForegroundColor Yellow
    exit 1
}

# Check if task already exists
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[WARN] Task '$TaskName' already exists. Removing..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Set master key environment variable if provided
if ($MasterKey -ne "") {
    Write-Host "Setting EIDOLON_MASTER_KEY environment variable..." -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable("EIDOLON_MASTER_KEY", $MasterKey, "User")
    Write-Host "[OK] EIDOLON_MASTER_KEY set (user scope)" -ForegroundColor Green
}

# Create the scheduled task
$action = New-ScheduledTaskAction `
    -Execute $BunPath `
    -Argument "run eidolon daemon start --foreground"

$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $Description

Write-Host ""
Write-Host "[OK] Scheduled task '$TaskName' created." -ForegroundColor Green
Write-Host ""
Write-Host "Commands:" -ForegroundColor Cyan
Write-Host "  Start now:  schtasks /run /tn $TaskName"
Write-Host "  Stop:       schtasks /end /tn $TaskName"
Write-Host "  Status:     schtasks /query /tn $TaskName"
Write-Host "  Uninstall:  powershell -File uninstall-service.ps1"
Write-Host ""
