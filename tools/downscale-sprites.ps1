<#
    downscale-sprites.ps1 — build the game's sprite set from Search and Go

    Search and Go ships 500x500 PNGs averaging ~270 KB each. Elemental Awakening
    alone is 79 creatures plus 79 shinies at 41.6 MB, and Galactic Adventures adds
    another 77 pairs. That is far too much for a service worker to precache on a
    phone — and this game has to work offline, so every sprite it uses must be
    precached.

    Nothing on the table is ever drawn larger than about 120 CSS px, so 256x256
    is already generous even at a 2x device pixel ratio. Re-encoding at that size
    cuts the set to a few MB.

    Every set CSV in the project root is walked, so adding a set means dropping
    its CSV in and re-running. Both sets share `images/` and `shiny/`: their
    filenames are disjoint, verified by the duplicate check below, and one flat
    folder per variant keeps Species.imagePath as a plain filename join.

    Re-runnable and idempotent. Source files are only ever read, never modified.

    Usage, from the project root:
        powershell -ExecutionPolicy Bypass -File tools\downscale-sprites.ps1

    Options:
        -Size 256       output edge length in pixels
        -Force          re-encode even when the output is already up to date
#>

[CmdletBinding()]
param(
    [string]   $Source = 'C:\Users\sandr\Downloads\Search and Go',
    [int]      $Size   = 256,
    [string[]] $Sets   = @('Elemental Awakening Creatures.csv', 'Galactic Adventures.csv'),
    [switch]   $Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Source)) { throw "Source project not found at $Source" }

<#  Collect the sprite filenames from every set.

    The Image column is the filename and `shiny/` mirrors `images/` name for
    name, so one list covers both folders. Property access is case-insensitive,
    which matters: Elemental Awakening spells the column "Image" and Galactic
    Adventures spells it "image". #>
$files = [ordered]@{}
$owner = @{}
$dupes = @()

foreach ($set in $Sets) {
    $csv = Join-Path $root $set
    if (-not (Test-Path $csv)) { throw "Set CSV not found at $csv" }

    $names = @(Import-Csv $csv | ForEach-Object { $_.Image } | Where-Object { $_ })
    $unique = @($names | Select-Object -Unique)

    foreach ($n in $unique) {
        if ($files.Contains($n)) { $dupes += "$n ($($owner[$n]) vs $set)"; continue }
        $files[$n] = $true
        $owner[$n] = $set
    }
    Write-Host ("{0,-40} {1,4} sprites" -f $set, $unique.Count) -ForegroundColor Cyan
}

<#  A collision would mean one set silently overwriting the other's artwork, and
    the loser would show the wrong creature everywhere. Refuse rather than guess. #>
if ($dupes.Count) {
    throw "Sets share sprite filenames, so they cannot share one folder: $($dupes -join '; ')"
}

$all = @($files.Keys)
Write-Host "$($all.Count) unique sprites across $($Sets.Count) set(s)" -ForegroundColor Cyan

<#  Resize one PNG, preserving transparency.

    GDI+ needs a little coaxing to do this cleanly: a 32bpp ARGB target cleared
    to transparent, high quality resampling, and a TileFlipXY wrap mode so the
    bicubic kernel does not sample past the edge and leave a halo. #>
function Resize-Png {
    param([string] $In, [string] $Out, [int] $Edge)

    $src = [System.Drawing.Image]::FromFile($In)
    try {
        $bmp = New-Object System.Drawing.Bitmap($Edge, $Edge, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

                $attr = New-Object System.Drawing.Imaging.ImageAttributes
                try {
                    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
                    $rect = New-Object System.Drawing.Rectangle(0, 0, $Edge, $Edge)
                    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height,
                                 [System.Drawing.GraphicsUnit]::Pixel, $attr)
                } finally { $attr.Dispose() }
            } finally { $g.Dispose() }

            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $bmp.Dispose() }
    } finally { $src.Dispose() }
}

$report = @()

foreach ($dir in 'images', 'shiny') {
    $inDir  = Join-Path $Source $dir
    $outDir = Join-Path $root   $dir
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

    $done = 0; $skipped = 0; $missing = @(); $bytesIn = 0; $bytesOut = 0

    foreach ($name in $all) {
        $in  = Join-Path $inDir  $name
        $out = Join-Path $outDir $name

        if (-not (Test-Path $in)) { $missing += $name; continue }

        $inItem   = Get-Item $in
        $bytesIn += $inItem.Length

        # Skip work that is already done, unless asked not to.
        if (-not $Force -and (Test-Path $out)) {
            $outItem = Get-Item $out
            if ($outItem.LastWriteTimeUtc -ge $inItem.LastWriteTimeUtc) {
                $bytesOut += $outItem.Length
                $skipped++
                continue
            }
        }

        Resize-Png -In $in -Out $out -Edge $Size
        $bytesOut += (Get-Item $out).Length
        $done++
    }

    $report += [pscustomobject]@{
        Folder    = $dir
        Written   = $done
        Skipped   = $skipped
        Missing   = $missing.Count
        'MB in'   = [math]::Round($bytesIn  / 1MB, 1)
        'MB out'  = [math]::Round($bytesOut / 1MB, 1)
    }

    if ($missing.Count) {
        Write-Warning "$dir is missing $($missing.Count) file(s): $($missing -join ', ')"
    }
}

$report | Format-Table -AutoSize

$totalIn  = ($report | Measure-Object 'MB in'  -Sum).Sum
$totalOut = ($report | Measure-Object 'MB out' -Sum).Sum
Write-Host ("Sprite set: {0} MB -> {1} MB at {2}x{2}" -f $totalIn, $totalOut, $Size) -ForegroundColor Green
