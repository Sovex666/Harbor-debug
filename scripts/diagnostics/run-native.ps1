param(
    [ValidateSet('all', 'cold', 'warm', 'stale', 'navigation', 'playback', 'session', 'export')][string]$Suite = 'all',
    [ValidateRange(1, 20)][int]$Repeat = 3,
    [ValidateRange(1, 86400)][int]$DurationSeconds = 1800
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$latest = Join-Path $root '.diag/latest.json'
if (!(Test-Path -LiteralPath $latest -PathType Leaf)) { throw 'No staged artifact; run pnpm diag:build first.' }
$meta = Get-Content -Raw -LiteralPath $latest | ConvertFrom-Json
if ($meta.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid staged hash.' }
$stage = Join-Path $root (Join-Path '.diag/artifacts' $meta.sha256)
$manifest = Join-Path $stage 'manifest.json'
$executable = Join-Path $stage 'harbor.exe'
if (!(Test-Path -LiteralPath $manifest -PathType Leaf) -or !(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Staged artifact is incomplete.' }
$staged = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
if ($staged.schemaVersion -ne 1 -or $staged.identity -ne 'app.harbor.context-review' -or $staged.sha256 -ne $meta.sha256 -or !$staged.files) { throw 'Invalid staging manifest.' }
if (((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Reparse point in staging tree.' }
foreach ($file in $staged.files) {
    if (!$file.path -or $file.path -match '(^|/)\.\.?(\/|$)|[:\\]' -or $file.path.StartsWith('/')) { throw 'Invalid staged file path.' }
    $path = Join-Path $stage $file.path
    if (!(Test-Path -LiteralPath $path -PathType Leaf) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Missing or reparse staged file.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Staged resource hash mismatch.' }
}
$artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant()
if ($artifactHash -ne $meta.sha256) { throw 'Staged artifact changed after staging.' }
$runDir = Join-Path (Join-Path $root '.diag/runs') ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$rows = [Collections.Generic.List[object]]::new()
$launches = [Collections.Generic.List[object]]::new()
function Free-Port { $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); return $port }
function Stop-Owned([Diagnostics.Process]$Process) {
    if (!$Process -or $Process.HasExited) { return }
    $Process.Refresh()
    if (!$Process.Path -or ![string]::Equals($Process.Path, $executable, [StringComparison]::OrdinalIgnoreCase) -or $Process.StartTime.ToUniversalTime().ToString('o') -ne $started) { throw 'Refusing to stop a process without matching path and start time.' }
    $Process.CloseMainWindow() | Out-Null
    if (!$Process.WaitForExit(10000)) { throw "Owned Harbor process did not exit gracefully (PID $($Process.Id)); refusing broad termination." }
}
for ($iteration = 1; $iteration -le $Repeat; $iteration++) {
    $port = Free-Port; $nonce = 'diag-' + [guid]::NewGuid().ToString('N')
    $oldNonce = $env:HARBOR_DIAG_RUN_NONCE; $oldArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:HARBOR_DIAG_RUN_NONCE = $nonce; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    $process = $null
    $started = $null
    $stopFailed = $false
    try {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant() -ne $artifactHash) { throw 'Staged executable changed between iterations.' }
        $process = Start-Process -FilePath $executable -WorkingDirectory $stage -WindowStyle Hidden -PassThru
        $started = $process.StartTime.ToUniversalTime().ToString('o')
        $launches.Add([pscustomobject]@{ iteration = $iteration; pid = $process.Id; executable = $executable; startedUtc = $started; nonce = $nonce; port = $port; sha256 = $artifactHash })
        $output = & node (Join-Path $PSScriptRoot 'run-suite.mjs') @($process.Id, $port, $executable, $started, $artifactHash, $nonce, $Suite) 2>&1
        $exit = $LASTEXITCODE
        try { $parsed = ($output | Select-Object -Last 1 | ConvertFrom-Json) } catch { $parsed = [pscustomobject]@{ results = @(@{ scenario = 'runner'; status = 'failed'; reason = 'invalid runner JSON' }) } }
        foreach ($row in @($parsed.results)) { $rows.Add([pscustomobject]@{ iteration = $iteration; scenario = $row.scenario; status = $row.status; reason = $row.reason; durationMs = $row.durationMs }) }
        if ($exit -ne 0 -and @($parsed.results | Where-Object status -eq 'failed').Count -eq 0) { $rows.Add([pscustomobject]@{ iteration = $iteration; scenario = 'runner'; status = 'failed'; reason = 'runner exited nonzero' }) }
    } catch {
        $rows.Add([pscustomobject]@{ iteration = $iteration; scenario = 'launch'; status = 'failed'; reason = 'Launch or runner failed' })
    } finally {
        try { Stop-Owned $process } catch { $stopFailed = $true; $rows.Add([pscustomobject]@{ iteration = $iteration; scenario = 'shutdown'; status = 'failed'; reason = 'Owned process did not exit; no further runs started' }) }
        if ($null -eq $oldNonce) { Remove-Item Env:HARBOR_DIAG_RUN_NONCE -ErrorAction SilentlyContinue } else { $env:HARBOR_DIAG_RUN_NONCE = $oldNonce }
        if ($null -eq $oldArgs) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue } else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldArgs }
    }
    foreach ($fixtureCase in @('cold', 'warm', 'stale', 'playback')) {
        if ($Suite -eq 'all' -or $Suite -eq $fixtureCase) { $rows.Add([pscustomobject]@{ iteration = $iteration; scenario = $fixtureCase; status = 'not-run'; reason = 'Isolated fixture and cache reset hooks unavailable' }) }
    }
    if ($stopFailed) { break }
}
$report = [pscustomobject]@{ schemaVersion = 2; artifactSha256 = $artifactHash; identity = 'app.harbor.context-review'; repeat = $Repeat; launches = $launches.ToArray(); scenarios = $rows.ToArray(); generatedUtc = [DateTime]::UtcNow.ToString('o') }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'report.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 8 | Write-Output
if (@($rows | Where-Object status -eq 'failed').Count -gt 0) { exit 1 }
if (@($rows | Where-Object status -eq 'passed').Count -eq 0) { exit 2 }
