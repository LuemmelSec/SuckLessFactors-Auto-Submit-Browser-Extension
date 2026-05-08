#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls the SuckLess Factors native messaging host and optionally
    removes all extension files.

.PARAMETER RemoveFiles
    Also delete the install folder (default: ask interactively).
#>
param(
    [switch]$RemoveFiles
)

$hostKey = 'com.sftimesheet.host'

$regKeys = @(
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostKey",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostKey",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostKey"
)

# ---------------------------------------------------------------------------
# Remove registry entries
# ---------------------------------------------------------------------------
foreach ($key in $regKeys) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Force
        Write-Host "Removed registry key: $key"
    } else {
        Write-Host "Not found (skipped): $key"
    }
}

# ---------------------------------------------------------------------------
# Optionally remove files
# ---------------------------------------------------------------------------
$installDir = $PSScriptRoot

if (-not $RemoveFiles) {
    Write-Host ""
    $answer = Read-Host "Delete all SuckLess Factors files from '$installDir'? [y/N]"
    $RemoveFiles = ($answer -eq 'y' -or $answer -eq 'Y')
}

if ($RemoveFiles) {
    # Walk up one level: native-host\ sits inside the root folder
    $rootDir = Split-Path $installDir -Parent
    if (Test-Path $rootDir) {
        Remove-Item -Path $rootDir -Recurse -Force
        Write-Host "Deleted folder: $rootDir"
    }
} else {
    Write-Host "Files kept at: $installDir"
}

Write-Host ""
Write-Host "Uninstall complete."
Write-Host "Remember to remove the extension from brave://extensions (or chrome:// / edge://) manually."
