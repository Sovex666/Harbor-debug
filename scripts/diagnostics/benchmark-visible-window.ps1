param(
  [Parameter(Mandatory = $true)][int]$BrowserProcessId,
  # Place the owned window behind other windows without activating it. With
  # native occlusion tracking disabled, a covered window keeps rendering.
  [switch]$SendToBack
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class BenchmarkWindow {
  public delegate bool EnumProc(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$script:found = $false
[void][BenchmarkWindow]::EnumWindows({
  param($handle, $state)
  [uint32]$windowProcessId = 0
  [void][BenchmarkWindow]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
  if ($windowProcessId -eq $BrowserProcessId -and [BenchmarkWindow]::IsWindowVisible($handle) -and -not [BenchmarkWindow]::IsIconic($handle)) {
    $script:found = $true
    if ($SendToBack) {
      # HWND_BOTTOM; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
      [void][BenchmarkWindow]::SetWindowPos($handle, [IntPtr]1, 0, 0, 0, 0, 0x0013)
    }
  }
  return $true
}, [IntPtr]::Zero)
if ($script:found) { 'visible' } else { 'hidden'; exit 1 }
