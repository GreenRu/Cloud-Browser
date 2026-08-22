<#
.SYNOPSIS
  Registers Stratus with Windows as a browser, so it can be chosen as the
  default and used to open web files.

.DESCRIPTION
  Windows will not let an application make itself the default - that has been
  the user's decision alone since Windows 10 1803. What an application can do
  is publish its capabilities, which is what this does.

  The layout matters more than it looks. A generic registration under
  Software\<App>\Capabilities makes Windows treat the program as *an app*; to
  be offered as a *browser* it has to live under
  Software\Clients\StartMenuInternet\<name>, with a StartMenu\StartMenuInternet
  value pointing back at itself. That is how Edge and Firefox are registered on
  this machine, and this script mirrors their shape.

  Everything is written under HKEY_CURRENT_USER, so no administrator rights are
  needed and nothing changes for other accounts. -Unregister removes all of it.

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
$ClientKey = "Software\Clients\StartMenuInternet\$AppName"
$CapabilityPath = "$ClientKey\Capabilities"

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

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenu "$AppName.lnk"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"

if ($Unregister) {
    if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }
    Remove-Key $uninstallKey
    Remove-Key "HKCU:\$ClientKey"
    Remove-Key "HKCU:\Software\Classes\$ProgIdHtml"
    Remove-Key "HKCU:\Software\Classes\$ProgIdUrl"
    Remove-Key "HKCU:\Software\$AppName"          # the earlier, generic layout
    Remove-Key 'HKCU:\Software\Classes\Applications\electron.exe'
    # Left behind by the app's previous name.
    Remove-Key 'HKCU:\Software\Classes\Applications\Cloud Browser.exe'
    $reg = 'HKCU:\Software\RegisteredApplications'
    if (Test-Path $reg) {
        Remove-ItemProperty -Path $reg -Name $AppName -ErrorAction SilentlyContinue
    }
    foreach ($ext in $FileTypes) {
        $openWith = "HKCU:\Software\Classes\$ext\OpenWithProgids"
        if (Test-Path $openWith) {
            Remove-ItemProperty -Path $openWith -Name $ProgIdHtml -ErrorAction SilentlyContinue
        }
    }
    Write-Output "Unregistered $AppName, and removed its Start menu entry."
    return
}

# --- work out what to launch -------------------------------------------------

if ($Exe) {
    if (-not (Test-Path $Exe)) { Write-Error "No executable at $Exe" }
    $launch = "`"$Exe`""
    $openOne = "`"$Exe`" `"%1`""
    $iconSource = $Exe
} else {
    # The development launcher: Electron plus this project directory. Smart App
    # Control blocks a freshly packaged build, but this binary is on millions of
    # machines and runs fine - see tools\make-shortcut.ps1 for the long version.
    $electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electron)) {
        Write-Error "electron.exe not found at $electron`nRun 'npm install' first, or pass -Exe."
    }
    $launch = "`"$electron`" `"$projectRoot`""
    $openOne = "`"$electron`" `"$projectRoot`" `"%1`""
    $iconSource = $electron
}

$icon = Join-Path $projectRoot 'assets\icon.ico'
$icon = if (Test-Path $icon) { "$icon,0" } else { "$iconSource,0" }

# --- the browser client entry, which is what the default list reads ----------

$client = "HKCU:\$ClientKey"
New-Item -Path "$client\DefaultIcon" -Force | Out-Null
New-Item -Path "$client\InstallInfo" -Force | Out-Null
New-Item -Path "$client\shell\open\command" -Force | Out-Null
New-Item -Path "$client\Capabilities\FileAssociations" -Force | Out-Null
New-Item -Path "$client\Capabilities\URLAssociations" -Force | Out-Null
New-Item -Path "$client\Capabilities\StartMenu" -Force | Out-Null

Set-ItemProperty -Path $client -Name '(Default)' -Value $AppName
Set-ItemProperty -Path "$client\DefaultIcon" -Name '(Default)' -Value $icon
# No %1 here: this command is "start the browser", not "open this thing".
Set-ItemProperty -Path "$client\shell\open\command" -Name '(Default)' -Value $launch
Set-ItemProperty -Path "$client\InstallInfo" -Name 'IconsVisible' -Value 1 -Type DWord

$cap = "$client\Capabilities"
Set-ItemProperty -Path $cap -Name 'ApplicationName' -Value $AppName
Set-ItemProperty -Path $cap -Name 'ApplicationDescription' -Value 'A small web browser with cloud-shaped tabs'
Set-ItemProperty -Path $cap -Name 'ApplicationIcon' -Value $icon
# Without this back-reference Windows does not count the entry as a browser.
Set-ItemProperty -Path "$cap\StartMenu" -Name 'StartMenuInternet' -Value $AppName

# --- the ProgIDs Windows actually opens things through -----------------------

function Set-ProgId($progId, $label, $isProtocol) {
    $base = "HKCU:\Software\Classes\$progId"
    New-Item -Path "$base\shell\open\command" -Force | Out-Null
    New-Item -Path "$base\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(Default)' -Value $label
    Set-ItemProperty -Path $base -Name 'FriendlyTypeName' -Value $label
    # What the "Open with" list shows; without it Windows falls back to the
    # executable's own name, which here would read "Electron".
    Set-ItemProperty -Path $base -Name 'FriendlyAppName' -Value $AppName
    if ($isProtocol) {
        # The presence of this empty value is what marks a ProgID as a URL handler.
        Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
    }
    Set-ItemProperty -Path "$base\DefaultIcon" -Name '(Default)' -Value $icon
    Set-ItemProperty -Path "$base\shell\open\command" -Name '(Default)' -Value $openOne
}

Set-ProgId $ProgIdHtml 'Stratus Document' $false
Set-ProgId $ProgIdUrl 'Stratus' $true

foreach ($ext in $FileTypes) {
    Set-ItemProperty -Path "$cap\FileAssociations" -Name $ext -Value $ProgIdHtml
    # Also offer Stratus under "Open with", whatever the current default is.
    $openWith = "HKCU:\Software\Classes\$ext\OpenWithProgids"
    New-Item -Path $openWith -Force | Out-Null
    # An empty REG_SZ, which is exactly what Edge and IE write here. A
    # REG_BINARY of zero length looks equivalent and is silently ignored.
    Set-ItemProperty -Path $openWith -Name $ProgIdHtml -Value '' -Type String
}

foreach ($scheme in @('http', 'https', 'stratus')) {
    Set-ItemProperty -Path "$cap\URLAssociations" -Name $scheme -Value $ProgIdUrl
}

# --- what the "Open with" list actually calls it ------------------------------
#
# Windows takes that name from the executable's own version resource, not from
# anything registered above, so the development launcher would be listed as
# "Electron". FriendlyAppName on the application key overrides it. A packaged
# build carries the right name itself and does not need this.
$appExe = "HKCU:\Software\Classes\Applications\$(Split-Path $iconSource -Leaf)"
New-Item -Path $appExe -Force | Out-Null
Set-ItemProperty -Path $appExe -Name 'FriendlyAppName' -Value $AppName

New-Item -Path 'HKCU:\Software\RegisteredApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name $AppName -Value $CapabilityPath

# --- make Windows consider it installed --------------------------------------
#
# The registry above is what Windows reads once it is already looking at
# Stratus. It is not what makes Windows look: the Default apps page lists
# *installed* applications, and something with no Start menu entry and no
# entry under Installed apps is not one. Every browser on this machine has
# both, which is why they appear and a registry-only registration does not.

$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($shortcutPath)
if ($Exe) {
    $link.TargetPath = $Exe
} else {
    $link.TargetPath = $electron
    $link.Arguments = "`"$projectRoot`""
}
$link.WorkingDirectory = $projectRoot
$link.Description = 'A small web browser with cloud-shaped tabs'
$iconFile = Join-Path $projectRoot 'assets\icon.ico'
if (Test-Path $iconFile) { $link.IconLocation = $iconFile }
$link.Save()

$version = '0.2.0'
try {
    $version = (Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
} catch { }

New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name 'DisplayName' -Value $AppName
Set-ItemProperty -Path $uninstallKey -Name 'DisplayIcon' -Value $icon
Set-ItemProperty -Path $uninstallKey -Name 'DisplayVersion' -Value $version
Set-ItemProperty -Path $uninstallKey -Name 'Publisher' -Value 'Sutton Sager'
Set-ItemProperty -Path $uninstallKey -Name 'InstallLocation' -Value $projectRoot
Set-ItemProperty -Path $uninstallKey -Name 'UninstallString' `
    -Value "powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Unregister"
Set-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -Type DWord

# Settings caches the app list; nudge the shell so the entry shows up now.
$sig = 'using System;using System.Runtime.InteropServices;public class Shell32Notify{[DllImport("shell32.dll")]public static extern void SHChangeNotify(int e,uint f,IntPtr a,IntPtr b);}'
if (-not ([System.Management.Automation.PSTypeName]'Shell32Notify').Type) { Add-Type -TypeDefinition $sig }
[Shell32Notify]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)

if (-not $Quiet) {
    Write-Output "Registered $AppName as a browser."
    Write-Output "  browser entry: HKCU\$ClientKey"
    Write-Output "  launches:      $launch"
    Write-Output "  opens a file:  $openOne"
    Write-Output "  file types:    $($FileTypes.Count)"
    Write-Output "  start menu:    $shortcutPath"
    Write-Output ''
    Write-Output 'Windows does not let an app make itself the default. To finish:'
    Write-Output '  Settings > Apps > Default apps, search "Stratus", then set http, https and .html'
    Write-Output '  (if Settings was already open, close and reopen it first)'
    Write-Output ''
    Write-Output 'Undo with: npm run unregister'
}
