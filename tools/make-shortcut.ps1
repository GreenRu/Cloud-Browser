<#
.SYNOPSIS
  Creates a desktop shortcut that launches Stratus without packaging it.

.DESCRIPTION
  Windows 11's Smart App Control blocks executables that are both unsigned and
  unknown to Microsoft's reputation graph. A freshly packaged build is exactly
  that - a one-of-a-kind hash - so it gets blocked, while the stock
  node_modules\electron\dist\electron.exe runs fine because that hash is on
  millions of machines.

  This shortcut launches the app through that already-trusted binary, passing
  the project directory as the app to run. No packaging, no signing, no need to
  weaken any security setting.

  Remove it by deleting the shortcut; nothing else is changed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
#>

[CmdletBinding()]
param(
    [string]$Name = 'Stratus',
    [string]$Destination = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
    Write-Error "electron.exe not found at $electron`nRun 'npm install' first."
}

$linkPath = Join-Path $Destination "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $electron
$shortcut.Arguments = "`"$projectRoot`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Stratus'

# Use the app's own icon when one has been added to assets\.
$icon = Join-Path $projectRoot 'assets\icon.ico'
if (Test-Path $icon) { $shortcut.IconLocation = $icon }

$shortcut.Save()

Write-Host "Created: $linkPath"
Write-Host "  target: $electron"
Write-Host "  app   : $projectRoot"
