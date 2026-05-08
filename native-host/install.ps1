#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the SuckLess Factors native messaging host for Brave, Chrome, and Edge.

.PARAMETER ExtensionId
    The unpacked extension ID shown on brave://extensions (or chrome://extensions /
    edge://extensions) after loading the extension folder.
    Example: abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
    .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
#>
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

# ---------------------------------------------------------------------------
# Recommended install location: %APPDATA%\SuckLessFactors\native-host
# If this script is already there, use its own directory.
# Otherwise offer to copy everything there.
# ---------------------------------------------------------------------------
$defaultTarget = Join-Path $env:APPDATA 'SuckLessFactors\native-host'
$scriptDir     = $PSScriptRoot

if ($scriptDir -ne $defaultTarget) {
    Write-Host ""
    Write-Host "Recommended install folder: $defaultTarget"
    Write-Host "Current location:           $scriptDir"
    Write-Host ""
    $move = Read-Host "Copy all files to the recommended location? [Y/n]"
    if ($move -ne 'n' -and $move -ne 'N') {
        if (-not (Test-Path $defaultTarget)) {
            New-Item -ItemType Directory -Path $defaultTarget -Force | Out-Null
        }
        Copy-Item -Path "$scriptDir\*" -Destination $defaultTarget -Recurse -Force
        Write-Host "Files copied to: $defaultTarget"
        Write-Host "Re-running install from the new location..."
        Write-Host ""
        & (Join-Path $defaultTarget 'install.ps1') -ExtensionId $ExtensionId
        exit
    }
}

$hostDir      = $PSScriptRoot
$batPath      = Join-Path $hostDir 'host.bat'
$manifestPath = Join-Path $hostDir 'com.sftimesheet.host.json'

if (-not (Test-Path $batPath)) {
    Write-Error "host.bat not found at: $batPath"
    exit 1
}

# Write the completed manifest
$manifest = [ordered]@{
    name            = 'com.sftimesheet.host'
    description     = 'SuckLess Factors Native Messaging Host'
    path            = $batPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "Manifest written to: $manifestPath"

# ---------------------------------------------------------------------------
# Register for each browser
# ---------------------------------------------------------------------------
$browsers = @(
    @{ Name = 'Brave';  Key = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.sftimesheet.host' },
    @{ Name = 'Chrome'; Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sftimesheet.host' },
    @{ Name = 'Edge';   Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sftimesheet.host' }
)

foreach ($browser in $browsers) {
    New-Item      -Path $browser.Key -Force | Out-Null
    Set-ItemProperty -Path $browser.Key -Name '(Default)' -Value $manifestPath
    Write-Host "Registered for $($browser.Name)"
}

Write-Host ""
Write-Host "Done. Reload the extension in your browser and you're ready to go."
Write-Host "Extension folder: $(Split-Path $hostDir -Parent)\extension"
