[CmdletBinding()]
param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$diag = Join-Path $root '.diag'
$inject = Join-Path $diag 'browser-inject.json'
$server = Join-Path $PSScriptRoot 'browser-profile-server.cjs'
if ($Refresh -or -not (Test-Path $inject)) {
  node (Join-Path $diag 'read-browser-copy.mjs')
}
if (-not (Test-Path $inject) -or -not (Test-Path $server)) {
  throw 'Browser profile snapshot is unavailable. Run the repository setup that creates .diag/read-browser-copy.mjs first.'
}
$port = Get-NetTCPConnection -LocalPort 1422 -State Listen -ErrorAction SilentlyContinue
$vitePort = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if (-not $vitePort) {
  Start-Process pnpm.cmd -ArgumentList 'dev' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $diag 'vite-browser.log') `
    -RedirectStandardError (Join-Path $diag 'vite-browser-errors.log')
}
if (-not $port) {
  Start-Process node -ArgumentList ('"' + $server + '"') -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $diag 'browser-fixture.log') `
    -RedirectStandardError (Join-Path $diag 'browser-fixture.err')
}
Write-Output 'Harbor browser profile test: http://127.0.0.1:1422/'
Write-Output 'Existing snapshot reused. Use -Refresh only when the Harbor profile changed.'
