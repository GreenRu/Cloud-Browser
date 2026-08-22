<#
.SYNOPSIS
  Registers Stratus with Windows so it can be picked as the default browser and
  used to open web files.

.DESCRIPTION
  Windows will not let an application make itself the default - that has been
  the user's decision alone since Windows 10 1803. What an application *can* do
  is publish its capabilities, which is what this does: after running it,
  Stratus appears in Settings > Apps > Default apps, where you assign http,
  https and whichever file types you want.

  Everything is written under HKEY_CURRENT_USER, so no administrator rights are
  needed and nothing is changed for other accounts. Run with -Unregister to
  remove every key again.

  Only file types a browser can actually display are claimed. Word documents
  are not among them: Chromium cannot render .doc or .docx, which is why Edge
  hands those to Office rather than opening them itself.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\register-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\register-windows.ps1 -Unregister
#>

[CmdletBinding()]
param(
    [switch]$Unregister,
    # Point at a packaged build instead of the development launcher.
    [string]$Exe,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$AppName = 'Stratus'
$ProgIdHtml = 'Stratus.Document'
$ProgIdUrl = 'Stratus.Url'
$CapabilityPath = "Software\$AppName\Capabilities"

$projectRoot = Split-Path -Parent $PSScriptRoot

# Types a Chromium-based browser can genuinely display.
$FileTypes = @(
    '.html', '.htm', '.xhtml', '.shtml',
    '.svg', '.svgz',
    '.pdf',
    '.txt', '.text', '.log',
    '.json', '.xml',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
    '.mhtml', '.webmanifest'
)

function Remove-Key($path) {
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}

if ($Unregister) {
    Remove-Key "HKCU:\Software\Classes\$ProgIdHtml"
    Remove-Key "HKCU:\Software\Classes\$ProgIdUrl"
    Remove-Key "HKCU:\Software\$AppName"
    $reg = 'HKCU:\Software\RegisteredApplications'
    if (Test-Path $reg) {
        Remove-ItemProperty -Path $reg -Name $AppName -ErrorAction SilentlyContinue
    }
    foreach ($ext in $FileTypes) {
        Remove-Key "HKCU:\Software\Classes\$ext\OpenWithProgids"
    }
    Write-Output "Unregistered $AppName. Windows may still list it until you sign out and back in."
    return
}

# --- work out what to launch -------------------------------------------------

if ($Exe) {
    if (-not (Test-Path $Exe)) { Write-Error "No executable at $Exe" }
    $command = "`"$Exe`" `"%1`""
    $iconSource = $Exe
} else {
    # The development launcher: Electron plus this project directory. Smart App
    # Control blocks a freshly packaged build, but this binary is on millions of
    # machines and runs fine - see tools\make-shortcut.ps1 for the long version.
    $electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electron)) {
        Write-Error "electron.exe not found at $electron`nRun 'npm install' first, or pass -Exe."
    }
    $command = "`"$electron`" `"$projectRoot`" `"%1`""
    $iconSource = $electron
}

$icon = Join-Path $projectRoot 'assets\icon.ico'
if (-not (Test-Path $icon)) { $icon = "$iconSource,0" }

# --- the two ProgIDs Windows opens things through ----------------------------

function Set-ProgId($progId, $label, $isProtocol) {
    $base = "HKCU:\Software\Classes\$progId"
    New-Item -Path "$base\shell\open\command" -Force | Out-Null
    New-Item -Path "$base\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(Default)' -Value $label
    if ($isProtocol) {
        # Presence of this empty value is what marks a ProgID as a URL handler.
        Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
    }
    Set-ItemProperty -Path "$base\DefaultIcon" -Name '(Default)' -Value $icon
    Set-ItemProperty -Path "$base\shell\open\command" -Name '(Default)' -Value $command
}

Set-ProgId $ProgIdHtml 'Stratus Document' $false
Set-ProgId $ProgIdUrl 'Stratus' $true

# --- capabilities, which is what Settings reads ------------------------------

$cap = "HKCU:\$CapabilityPath"
New-Item -Path "$cap\FileAssociations" -Force | Out-Null
New-Item -Path "$cap\URLAssociations" -Force | Out-Null
Set-ItemProperty -Path $cap -Name 'ApplicationName' -Value $AppName
Set-ItemProperty -Path $cap -Name 'ApplicationDescription' -Value 'A small web browser with cloud-shaped tabs'
Set-ItemProperty -Path $cap -Name 'ApplicationIcon' -Value $icon

foreach ($ext in $FileTypes) {
    Set-ItemProperty -Path "$cap\FileAssociations" -Name $ext -Value $ProgIdHtml
    # Also offer Stratus in "Open with", whatever the current default is.
    $openWith = "HKCU:\Software\Classes\$ext\OpenWithProgids"
    New-Item -Path $openWith -Force | Out-Null
    Set-ItemProperty -Path $openWith -Name $ProgIdHtml -Value ([byte[]]@()) -Type Binary
}

foreach ($scheme in @('http', 'https', 'stratus')) {
    Set-ItemProperty -Path "$cap\URLAssociations" -Name $scheme -Value $ProgIdUrl
}

New-Item -Path 'HKCU:\Software\RegisteredApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name $AppName -Value $CapabilityPath

if (-not $Quiet) {
    Write-Output "Registered $AppName."
    Write-Output "  launches: $command"
    Write-Output "  file types: $($FileTypes.Count)"
    Write-Output ''
    Write-Output 'Windows does not let an app make itself the default. To finish:'
    Write-Output '  Settings > Apps > Default apps > Stratus > set http, https and .html'
    Write-Output ''
    Write-Output 'Undo with: powershell -ExecutionPolicy Bypass -File tools\register-windows.ps1 -Unregister'
}
