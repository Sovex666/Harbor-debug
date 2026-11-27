param([int]$OwnerPid, [int]$Port, [string]$Executable, [string]$StartTimeUtc, [string]$Hash)
$ErrorActionPreference = 'Stop'
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid"
if (!$process -or !$process.ExecutablePath -or ![string]::Equals($process.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Owner PID/path mismatch' }
$actualStart = (Get-Process -Id $OwnerPid).StartTime.ToUniversalTime().ToString('o')
if ($actualStart -ne $StartTimeUtc) { throw 'Owner PID was reused' }
if ((Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'Owner artifact changed' }
$all = @(Get-CimInstance Win32_Process)
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($OwnerPid)
do { $count = $owned.Count; foreach ($p in $all) { if ($owned.Contains([int]$p.ParentProcessId)) { [void]$owned.Add([int]$p.ProcessId) } } } while ($count -ne $owned.Count)
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0 -or @($listeners | Where-Object { !$owned.Contains([int]$_.OwningProcess) -or $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -ne 0) { throw 'CDP listener is absent, non-loopback, or not owned' }
