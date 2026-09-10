<#
    downscale-sprites.ps1 — build the game's sprite set from Search and Go

    Search and Go ships 500x500 PNGs averaging ~270 KB each. The 79 Elemental
    Awakening creatures plus their 79 shinies come to 41.6 MB, which is far too
    much for a service worker to precache on a phone — and this game has to work
    offline, so every sprite it uses must be precached.

    Nothing on the table is ever drawn larger than about 120 CSS px, so 256x256
    is already generous even at a 2x device pixel ratio. Re-encoding at that size
    cuts the set to a few MB.

    Re-runnable and idempotent: it reads the creature list straight from the CSV,
    so when you add creatures to the set you just run it again. Source files are
    only ever read, never modified.

    Usage, from the project root:
        powershell -ExecutionPolicy Bypass -File tools\downscale-sprites.ps1

    Options:
        -Size 256       output edge length in pixels
        -Force          re-encode even when the output is already up to date
#>

[CmdletBinding()]
param(
    [string] $Source = 'C:\Users\sandr\Downloads\Search and Go',
    [int]    $Size   = 256,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$csv  = Join-Path $root 'Elemental Awakening Creatures.csv'

if (-not (Test-Path $csv))    { throw "Creature CSV not found at $csv" }
if (-not (Test-Path $Source)) { throw "Source project not found at $Source" }

# The CSV's Image column is the filename, and `shiny/` mirrors `images/`
# filename for filename, so one list covers both folders.
$files = @(Import-Csv $csv | ForEach-Object { $_.Image } | Where-Object { $_ } | Select-Object -Unique)
Write-Host "$($files.Count) creature sprites listed in the CSV" -ForegroundColor Cyan

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

    foreach ($name in $files) {
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
