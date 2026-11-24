$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$debugDir = Join-Path $root 'src-tauri/target/debug'
$diagDir = Join-Path $root '.diag'
function Assert-NoReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in artifact path' }
        $item = $item.Parent
    }
}
function Copy-Artifact([string]$destination) {
    New-Item -ItemType Directory -Path $destination | Out-Null
    $required = @('harbor.exe','libmpv-2.dll','mpv.exe','ffmpeg.exe','ffprobe.exe','yt-dlp.exe','notices','fonts','resources')
    $sidecars = @(Get-ChildItem -LiteralPath $debugDir -File -Force | Where-Object { $_.Extension -in @('.exe','.dll','.pdb') } | ForEach-Object { $_.Name })
    foreach ($name in @($required + $sidecars | Select-Object -Unique)) {
        $source = Join-Path $debugDir $name
        if (!(Test-Path -LiteralPath $source)) { throw "Missing artifact component: $name" }
        Assert-NoReparse $source
        if ((Get-Item -LiteralPath $source).PSIsContainer) {
            Get-ChildItem -LiteralPath $source -Recurse -Force | ForEach-Object {
                if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in artifact tree' }
            }
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name) -Recurse
        if ((Get-Item -LiteralPath $source).PSIsContainer) {
            foreach ($file in @(Get-ChildItem -LiteralPath $source -Recurse -File -Force)) {
                $copy = Join-Path (Join-Path $destination $name) $file.FullName.Substring($source.Length + 1)
                if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) { throw 'Artifact preservation verification failed' }
            }
        } elseif ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $destination $name) -Algorithm SHA256).Hash) { throw 'Artifact preservation verification failed' }
    }
}
Set-Location -LiteralPath $root
Assert-NoReparse $root
Assert-NoReparse $debugDir
if (Test-Path -LiteralPath $diagDir) { Assert-NoReparse $diagDir }
$lib = Get-Content -Raw -LiteralPath (Join-Path $root 'src-tauri/src/lib.rs')
if (!$lib.Contains('context_review::attest_storage(') -or !$lib.Contains('context_review::identity_script(')) { throw 'Native startup attestation/identity hooks are not integrated; refusing diagnostic build.' }
foreach ($command in @('pnpm','node','cargo')) { if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing tool: $command" } }
foreach ($resource in @('src-tauri/resources/capstan','src-tauri/resources/harbor-stream-blocker','src-tauri/resources/pokemon-engine','src-tauri/fonts')) {
    if (!(Test-Path -LiteralPath (Join-Path $root $resource))) { throw "Missing resource: $resource" }
}
& node scripts/capstan-stage.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'Capstan preflight failed; no build started' }
$preserved = Join-Path $diagDir ('preserved/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Split-Path $preserved) | Out-Null
Copy-Artifact $preserved
& pnpm tauri build --debug --no-bundle --features context-review --config src-tauri/tauri.context-review.conf.json
if ($LASTEXITCODE -ne 0) { throw "Build failed; previous artifact preserved in $preserved" }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $debugDir 'harbor.exe')).Hash.ToLowerInvariant()
$stage = Join-Path $diagDir ('artifacts/' + $hash)
if (Test-Path -LiteralPath $stage) { throw 'Hash stage already exists; refusing to overwrite' }
New-Item -ItemType Directory -Force -Path (Split-Path $stage) | Out-Null
Copy-Artifact $stage
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage 'harbor.exe')).Hash.ToLowerInvariant() -ne $hash) { throw 'Staged executable hash mismatch' }
$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
    @{ path = $_.FullName.Substring($stage.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(); bytes = $_.Length }
})
$manifest = @{ schemaVersion = 1; identity = 'app.harbor.context-review'; sha256 = $hash; files = $files }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8
@{ sha256 = $hash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $diagDir 'latest.json') -Encoding UTF8
Write-Host "Staged: $stage"
Write-Host "Preserved prior artifact: $preserved"
