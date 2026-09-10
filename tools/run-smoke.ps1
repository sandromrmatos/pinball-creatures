<#
    run-smoke.ps1 — boot the real app in headless Chrome and report

    Companion to run-selftest.ps1. That one imports the modules and tests the
    logic; this one loads index.html and checks the game actually starts, draws
    something, and survives being played and navigated. A typo in an element id
    passes every unit test and still leaves a black screen.

    Usage, from the project root:
        powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1

    Options:
        -Port 8132      port for the temporary server
        -Full           print passing checks and notes too
        -Timeout 180    seconds to wait for the page
#>

[CmdletBinding()]
param(
    [int]    $Port = 8132,
    [switch] $Full,
    [double] $Timeout = 180
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) { throw 'No Chrome or Edge found; cannot run the smoke test.' }

$resultFile = Join-Path $env:TEMP 'pbc-smoke-result.json'
$profileDir = Join-Path $env:TEMP 'pbc-smoke-profile'
Remove-Item $resultFile -ErrorAction SilentlyContinue

$server = $null
$chrome = $null

try {
    $server = Start-Process -FilePath 'python' -PassThru -WindowStyle Hidden `
        -WorkingDirectory $root `
        -ArgumentList @('tools/testserver.py', '--port', $Port, '--root', '.',
                        '--out', $resultFile, '--timeout', $Timeout)

    $deadline = [datetime]::UtcNow.AddSeconds(15)
    $up = $false
    while ([datetime]::UtcNow -lt $deadline) {
        try {
            $c = [System.Net.Sockets.TcpClient]::new()
            $c.Connect('127.0.0.1', $Port)
            $c.Close()
            $up = $true
            break
        } catch { Start-Sleep -Milliseconds 150 }
    }
    if (-not $up) { throw "The test server never came up on port $Port." }

    Write-Host "Booting index.html in $(Split-Path -Leaf $browser) ..." -ForegroundColor Cyan

    # A fresh profile: a service worker or IndexedDB left from a previous run
    # would let a broken build appear to work.
    Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

    $chrome = Start-Process -FilePath $browser -PassThru -WindowStyle Hidden -ArgumentList @(
        '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
        '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--window-size=430,900',
        "--user-data-dir=$profileDir",
        "http://127.0.0.1:$Port/smoketest.html"
    )

    $server.WaitForExit([int]([math]::Ceiling($Timeout * 1000) + 15000)) | Out-Null
}
finally {
    foreach ($p in @($chrome, $server)) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
}

if (-not (Test-Path $resultFile)) {
    Write-Host 'NO RESULT: the smoke test never finished.' -ForegroundColor Red
    exit 1
}

$data = Get-Content $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($r in $data.report) {
    switch ($r.kind) {
        'group' { Write-Host $r.text -ForegroundColor Yellow }
        'fail'  { Write-Host ("  FAIL  {0}{1}" -f $r.label, ($(if ($r.detail) { "  == $($r.detail)" } else { '' }))) -ForegroundColor Red }
        'pass'  { if ($Full) { Write-Host ("  pass  {0}" -f $r.label) -ForegroundColor DarkGreen } }
        'note'  { if ($Full) { Write-Host ("        {0}" -f $r.text) -ForegroundColor DarkGray } }
    }
}

Write-Host ''
if ($data.threw) {
    Write-Host 'THREW:' -ForegroundColor Red
    Write-Host $data.threw -ForegroundColor DarkRed
}

if ($data.fail -eq 0 -and -not $data.threw) {
    Write-Host "OK  $($data.pass) checks passed" -ForegroundColor Green
    exit 0
}

Write-Host "FAILED  $($data.fail) of $($data.pass + $data.fail) checks" -ForegroundColor Red
exit 1
