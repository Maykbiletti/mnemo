# Mnemo Dispatcher
# Polls a local inbox for one or more agent names and pastes each new brief into
# the matching terminal window. The window match is based on the terminal tab
# title containing the agent id.
#
# Example:
#   powershell -ExecutionPolicy Bypass -File .\dispatcher.ps1 `
#     -Inbox "$env:USERPROFILE\mnemo-inbox" `
#     -Agents agent-a,agent-b

param(
  [string] $Inbox = $(if ($env:MNEMO_DISPATCHER_INBOX) { $env:MNEMO_DISPATCHER_INBOX } else { Join-Path $env:USERPROFILE "mnemo-inbox" }),
  [string[]] $Agents = @("agent-a","agent-b")
)

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

$Done  = Join-Path $Inbox "done"
New-Item -ItemType Directory -Force -Path $Done | Out-Null
foreach ($agent in $Agents) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Inbox $agent) | Out-Null
}

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
    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] no window matching '$title' - skipping"
    return $false
  }
  [void][Win32]::ShowWindow($hWnd, 9) # SW_RESTORE
  [void][Win32]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 250
  Set-Clipboard -Value $brief
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  return $true
}

Write-Host "mnemo-dispatcher running. Inbox=$Inbox Agents=$($Agents -join ','). Ctrl+C to stop."

while ($true) {
  foreach ($who in $Agents) {
    $dir = Join-Path $Inbox $who
    $files = Get-ChildItem -Path $dir -Filter "*.md" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
    foreach ($f in $files) {
      $brief = Get-Content -Raw -Path $f.FullName
      $titleNeedle = "(?i)" + [regex]::Escape($who)
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
