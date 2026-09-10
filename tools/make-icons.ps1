<#
    make-icons.ps1 — build the PWA icons

    Chrome will not offer to install a web app without a large enough icon,
    and it wants a maskable one too or Android crops the art into a circle and
    cuts the edges off. The creature sprites are transparent PNGs, so they are
    composited onto the app's background colour with a safe-zone inset for the
    maskable variant.

    Sources come from the full-size art in Search and Go rather than the
    downscaled copies in this project, so a 512px icon is a real 512px icon.

    Usage, from the project root:
        powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#>

[CmdletBinding()]
param(
    [string] $Source = 'C:\Users\sandr\Downloads\Search and Go',
    [string] $Creature = 'Pheonyx.png',
    [string] $Background = '#0B1024'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$art = Join-Path $Source "images\$Creature"
if (-not (Test-Path $art)) { throw "Could not find $art" }

$bg = [System.Drawing.ColorTranslator]::FromHtml($Background)

<#  One icon.

    `Inset` is the fraction of the edge left clear. A maskable icon has to
    survive being cropped to a circle, which eats roughly 10% off each side,
    so its art is drawn smaller inside the same canvas. #>
function New-Icon {
    param([int] $Size, [double] $Inset, [string] $Out)

    $src = [System.Drawing.Image]::FromFile($art)
    try {
        $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $g.Clear($bg)
                $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

                $pad = [int]([math]::Round($Size * $Inset))
                $box = $Size - ($pad * 2)
                $rect = New-Object System.Drawing.Rectangle($pad, $pad, $box, $box)

                $attr = New-Object System.Drawing.Imaging.ImageAttributes
                try {
                    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
                    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height,
                                 [System.Drawing.GraphicsUnit]::Pixel, $attr)
                } finally { $attr.Dispose() }
            } finally { $g.Dispose() }

            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $bmp.Dispose() }
    } finally { $src.Dispose() }

    "{0,-28} {1,6:N0} KB" -f (Split-Path -Leaf $Out), ((Get-Item $Out).Length / 1KB)
}

New-Icon -Size 192 -Inset 0.06 -Out (Join-Path $outDir 'icon-192.png')
New-Icon -Size 512 -Inset 0.06 -Out (Join-Path $outDir 'icon-512.png')
New-Icon -Size 512 -Inset 0.18 -Out (Join-Path $outDir 'icon-maskable-512.png')

Write-Host 'Icons written to icons/' -ForegroundColor Green
