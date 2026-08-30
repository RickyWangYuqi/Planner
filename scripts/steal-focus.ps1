# 用 AttachThreadInput 技巧把指定进程的窗口带到前台（后台进程也可用）
param([string]$ProcessName = "notepad")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@

$proc = Get-Process -Name $ProcessName -ErrorAction Stop |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $proc) { Write-Error "no window for $ProcessName"; exit 1 }

$h = $proc.MainWindowHandle
[FG2]::ShowWindow($h, 9) | Out-Null # SW_RESTORE
Start-Sleep -Milliseconds 200

$fg = [FG2]::GetForegroundWindow()
$fgThread = [FG2]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$myThread = [FG2]::GetCurrentThreadId()
[FG2]::AttachThreadInput($fgThread, $myThread, $true) | Out-Null
$ok = [FG2]::SetForegroundWindow($h)
[FG2]::AttachThreadInput($fgThread, $myThread, $false) | Out-Null

if ($ok) { "foreground set OK" } else { "foreground set FAILED" }
exit 0
