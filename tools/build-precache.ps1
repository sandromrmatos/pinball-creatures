<#
    build-precache.ps1 — list every sprite for the service worker to cache

    sw.js keeps the shell (markup, modules, CSVs) in a hand-written list,
    because that set is small and its absence means "no game". The sprites are
    a different problem: 158 files, and they change whenever the CSV does. So
    they are generated here instead of being maintained by hand.

    The list is derived from the CSV rather than from the contents of images/,
    so it can never drift from what the game will actually ask for. A file that
    is listed but missing is reported here rather than discovered as a blank
    creature later.

    Re-run whenever the creature list changes, alongside downscale-sprites.ps1.

    Usage, from the project root:
        powershell -ExecutionPolicy Bypass -File tools\build-precache.ps1
#>

[CmdletBinding()]
param(
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$csv = Join-Path $root 'Elemental Awakening Creatures.csv'
$out = Join-Path $root 'precache.json'

if (-not (Test-Path $csv)) { throw "Creature CSV not found at $csv" }

$names = @(Import-Csv $csv | ForEach-Object { $_.Image } | Where-Object { $_ } | Select-Object -Unique)

$assets = New-Object System.Collections.Generic.List[string]
$missing = New-Object System.Collections.Generic.List[string]
$bytes = 0

foreach ($dir in 'images', 'shiny') {
    foreach ($name in $names) {
        $path = Join-Path $root "$dir\$name"
        # The URL has to be encoded exactly as Species.imagePath encodes it, or
        # the service worker caches a key the game never requests.
        $url = "$dir/" + [uri]::EscapeDataString($name)

        if (Test-Path $path) {
            $assets.Add($url)
            $bytes += (Get-Item $path).Length
        } else {
            $missing.Add($url)
        }
    }
}

$payload = [ordered]@{
    generated = (Get-Date).ToString('o')
    count     = $assets.Count
    bytes     = $bytes
    assets    = $assets
}

$json = $payload | ConvertTo-Json -Depth 3
Set-Content -Path $out -Value $json -Encoding UTF8

if (-not $Quiet) {
    "{0} assets, {1:N1} MB -> precache.json" -f $assets.Count, ($bytes / 1MB) | Write-Host -ForegroundColor Green
    if ($missing.Count) {
        Write-Warning "$($missing.Count) listed sprite(s) are missing and were skipped:"
        $missing | Select-Object -First 10 | ForEach-Object { "  $_" }
        Write-Host '  run tools\downscale-sprites.ps1 to build them' -ForegroundColor Yellow
    }
}
