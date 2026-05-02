# Codex Dispatcher
# Polls C:\Users\racim\codex-inbox\{otto,frida}\*.md, pastes each new brief
# into the matching terminal window (matched by window title), then moves
# the brief to codex-inbox\done\.
#
# Run once: powershell -ExecutionPolicy Bypass -File C:\Users\racim\codex-dispatcher.ps1
# It runs in the foreground forever and prints a status line per dispatch.
#
# Window-title rules:
#   Otto  -> any window whose title contains "Otto"  OR contains "otto"
#   Frida -> any window whose title contains "Frida" OR contains "frida"
# Set the terminal tab title to "Otto" / "Frida" once (e.g. in Windows Terminal:
# right-click the tab -> Rename Tab -> "Otto").

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$Inbox = "C:\Users\racim\codex-inbox"
$Done  = Join-Path $Inbox "done"
New-Item -ItemType Directory -Force -Path $Done | Out-Null

function Find-WindowByTitle {
  param([string]$needle)
  $found = [IntPtr]::Zero
  $cb = [Win32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
    $len = [Win32]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title -match $needle) {
      $script:found = $hWnd
      return $false
    }
    return $true
  }
  $script:found = [IntPtr]::Zero
  [void][Win32]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

function Send-BriefToWindow {
  param([string]$title, [string]$brief)
  $hWnd = Find-WindowByTitle -needle $title
  if ($hWnd -eq [IntPtr]::Zero) {
    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] no window matching '$title' — skipping"
    return $false
  }
  [void][Win32]::ShowWindow($hWnd, 9) # SW_RESTORE
  [void][Win32]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 250
  Set-Clipboard -Value $brief
  Start-Sleep -Milliseconds 100
  # Paste (Ctrl+V) and then Enter
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  return $true
}

Write-Host "codex-dispatcher running. Watching $Inbox\otto and $Inbox\frida. Ctrl+C to stop."

while ($true) {
  foreach ($who in @("otto","frida")) {
    $dir = Join-Path $Inbox $who
    $files = Get-ChildItem -Path $dir -Filter "*.md" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
    foreach ($f in $files) {
      $brief = Get-Content -Raw -Path $f.FullName
      $titleNeedle = if ($who -eq "otto") { "(?i)otto" } else { "(?i)frida" }
      $ok = Send-BriefToWindow -title $titleNeedle -brief $brief
      if ($ok) {
        $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
        $dest = Join-Path $Done ("$who-$stamp-" + $f.Name)
        Move-Item -Path $f.FullName -Destination $dest -Force
        Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] dispatched $who <- $($f.Name) -> done"
      }
    }
  }
  Start-Sleep -Seconds 5
}
