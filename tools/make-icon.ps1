<#
.SYNOPSIS
  Draws assets\icon.ico from the same cloud mark the app uses.

.DESCRIPTION
  The shape is the logo path scaled into each icon size: a flat-bottomed body
  with three lobes, filled white over the sky gradient. It is drawn rather than
  scaled from one bitmap so the small sizes stay crisp - a 16px icon downsampled
  from 256px turns to mush.

  Windows reads sizes down to 16px for the title bar and up to 256px for large
  tiles, so all of them are written into one .ico. Each entry is a PNG, which
  Windows has accepted since Vista.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#>

[CmdletBinding()]
param(
    [string]$Out,
    [int[]]$Sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $projectRoot 'assets\icon.ico' }
$assets = Split-Path -Parent $Out
if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Path $assets -Force | Out-Null }

# The logo path lives in a 24-unit box; these are its circles and its baseline.
$LOBES = @(
    @{ cx = 11.5; cy = 10.6; r = 5.5 },   # the tall one, left of centre
    @{ cx = 17.4; cy = 14.0; r = 4.0 },
    @{ cx = 7.3;  cy = 13.8; r = 4.2 }   # cy + r lands exactly on the baseline
)
$BODY = @{ left = 4.4; right = 21.6; top = 12.4; bottom = 18.0 }

function New-CloudBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $s = $size / 24.0

    # Sky, rounded like the rest of the app.
    $radius = [Math]::Max(2, $size * 0.22)
    $round = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $round.AddArc(0, 0, $d, $d, 180, 90)
    $round.AddArc($size - $d, 0, $d, $d, 270, 90)
    $round.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $round.AddArc(0, $size - $d, $d, $d, 90, 90)
    $round.CloseFigure()

    $sky = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point(0, $size)),
        [System.Drawing.Color]::FromArgb(255, 116, 177, 229),
        [System.Drawing.Color]::FromArgb(255, 169, 208, 239))
    $g.FillPath($sky, $round)

    # The cloud, as one silhouette so the lobes never show a seam. Winding fill
    # is what makes that true: the default alternate mode treats every overlap
    # as a hole, and the shape comes out as a tangle of rings.
    $cloud = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cloud.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
    foreach ($l in $LOBES) {
        $r = $l.r * $s
        $cloud.AddEllipse(($l.cx * $s - $r), ($l.cy * $s - $r), ($r * 2), ($r * 2))
    }
    $bx = $BODY.left * $s
    $by = $BODY.top * $s
    $bw = ($BODY.right - $BODY.left) * $s
    $bh = ($BODY.bottom - $BODY.top) * $s
    $br = $bh / 2
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $body.AddArc($bx, $by, ($br * 2), ($br * 2), 90, 180)
    $body.AddArc(($bx + $bw - $br * 2), $by, ($br * 2), ($br * 2), 270, 180)
    $body.CloseFigure()
    $cloud.AddPath($body, $false)

    $g.FillPath([System.Drawing.Brushes]::White, $cloud)

    $g.Dispose(); $sky.Dispose(); $round.Dispose(); $cloud.Dispose(); $body.Dispose()
    return $bmp
}

# --- pack the sizes into one .ico -------------------------------------------

$pngs = @()
foreach ($size in $Sizes) {
    $bmp = New-CloudBitmap $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , @{ size = $size; bytes = $ms.ToArray() }
    $ms.Dispose(); $bmp.Dispose()
}

$stream = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($stream)

# ICONDIR
$w.Write([UInt16]0)                 # reserved
$w.Write([UInt16]1)                 # type: icon
$w.Write([UInt16]$pngs.Count)

# ICONDIRENTRY per image, 16 bytes each
$offset = 6 + (16 * $pngs.Count)
foreach ($p in $pngs) {
    $dim = if ($p.size -ge 256) { 0 } else { $p.size }   # 0 means 256
    $w.Write([Byte]$dim)
    $w.Write([Byte]$dim)
    $w.Write([Byte]0)               # palette colours
    $w.Write([Byte]0)               # reserved
    $w.Write([UInt16]1)             # colour planes
    $w.Write([UInt16]32)            # bits per pixel
    $w.Write([UInt32]$p.bytes.Length)
    $w.Write([UInt32]$offset)
    $offset += $p.bytes.Length
}
foreach ($p in $pngs) { $w.Write($p.bytes) }

$w.Flush()
[System.IO.File]::WriteAllBytes($Out, $stream.ToArray())
$w.Dispose(); $stream.Dispose()

$kb = [Math]::Round((Get-Item $Out).Length / 1KB, 1)
Write-Output "Wrote $Out"
Write-Output "  sizes: $($Sizes -join ', ')"
Write-Output "  size:  $kb KB"
