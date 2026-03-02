# Eidolon AI Assistant -- Windows Service Uninstallation
# Removes the Eidolon scheduled task and optionally cleans up environment variables.
#
# Usage: powershell -ExecutionPolicy Bypass -File uninstall-service.ps1

param(
    [switch]$RemoveMasterKey = $false
)

$ErrorActionPreference = "Stop"
$TaskName = "EidolonDaemon"

Write-Host "=== Eidolon Service Uninstaller ===" -ForegroundColor Cyan
Write-Host ""

# Stop the task if running
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq "Running") {
        Write-Host "Stopping running task..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 2
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[OK] Task '$TaskName' removed." -ForegroundColor Green
} else {
    Write-Host "[INFO] Task '$TaskName' not found." -ForegroundColor Yellow
}

# Optionally remove the master key environment variable
if ($RemoveMasterKey) {
    $existing = [Environment]::GetEnvironmentVariable("EIDOLON_MASTER_KEY", "User")
    if ($existing) {
        [Environment]::SetEnvironmentVariable("EIDOLON_MASTER_KEY", $null, "User")
        Write-Host "[OK] EIDOLON_MASTER_KEY environment variable removed." -ForegroundColor Green
    } else {
        Write-Host "[INFO] EIDOLON_MASTER_KEY not set." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Eidolon service has been uninstalled." -ForegroundColor Cyan
Write-Host "Data and config files have NOT been removed." -ForegroundColor Yellow
Write-Host ""
