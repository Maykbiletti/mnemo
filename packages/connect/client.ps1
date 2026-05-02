# Mnemo Connect — PowerShell client (terminal-paste transport)
#
# Registers each agent with the hub, polls for briefs, and pastes them into
# the matching Windows Terminal tab via clipboard + Ctrl+V + Enter.
#
# Set the Windows Terminal tab title for each agent so the script can find
# the window: right-click tab → Rename Tab → "Otto" / "Frida".
#
# Usage:
#   $env:MNEMO_URL = "http://127.0.0.1:7117"
#   powershell -ExecutionPolicy Bypass -File client.ps1 `
#     -Agents otto,frida `
#     -Channels listings,deploy `
#     -Skills scraper,deploy

param(
  [Parameter(Mandatory)] [string[]] $Agents,
  [string[]] $Channels = @(),
  [string[]] $Skills = @(),
  [int] $HeartbeatSeconds = 30,
  [int] $PullSeconds = 5
)

$MnemoUrl = $env:MNEMO_URL
if (-not $MnemoUrl) { $MnemoUrl = "http://127.0.0.1:7117" }
$MnemoUrl = $MnemoUrl.TrimEnd('/')

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

function Call-Tool {
  param([string] $Tool, [hashtable] $Args)
  $body = $Args | ConvertTo-Json -Depth 8 -Compress
  try {
    return Invoke-RestMethod -Method POST -Uri "$MnemoUrl/tool/$Tool" `
      -ContentType "application/json" -Body $body -TimeoutSec 8
  } catch {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] $Tool failed: $($_.Exception.Message)"
    return $null
  }
}

function Find-WindowByTitle {
  param([string] $Needle)
  $found = [IntPtr]::Zero
  $cb = [Win32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
    $len = [Win32]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    if ($sb.ToString() -match $Needle) { $script:found = $hWnd; return $false }
    return $true
  }
  $script:found = [IntPtr]::Zero
  [void][Win32]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

function Send-ToWindow {
  param([string] $Title, [string] $Text)
  $hWnd = Find-WindowByTitle -Needle "(?i)$Title"
  if ($hWnd -eq [IntPtr]::Zero) {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] no window matching '$Title'"
    return $false
  }
  [void][Win32]::ShowWindow($hWnd, 9)
  [void][Win32]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 250
  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  return $true
}

# Register each agent + subscribe to channels
foreach ($agent in $Agents) {
  Call-Tool -Tool "mem_connect_register" -Args @{
    agent_name   = $agent
    display_name = $agent
    host         = $env:COMPUTERNAME
    pid          = $PID
    skills       = $Skills
    meta         = @{ transport = "terminal-paste"; started_at = (Get-Date).ToUniversalTime().ToString("o") }
  } | Out-Null
  foreach ($ch in $Channels) {
    Call-Tool -Tool "mem_connect_channel_upsert"    -Args @{ name = $ch } | Out-Null
    Call-Tool -Tool "mem_connect_channel_subscribe" -Args @{ channel = $ch; agent_name = $agent } | Out-Null
  }
  Write-Host "[$(Get-Date -Format HH:mm:ss)] registered $agent on $MnemoUrl channels=$($Channels -join ',')"
}

$lastHeartbeat = [DateTime]::MinValue
while ($true) {
  if ((Get-Date) - $lastHeartbeat -gt [TimeSpan]::FromSeconds($HeartbeatSeconds)) {
    foreach ($agent in $Agents) {
      Call-Tool -Tool "mem_connect_heartbeat" -Args @{ agent_name = $agent; status = "online" } | Out-Null
    }
    $lastHeartbeat = Get-Date
  }
  foreach ($agent in $Agents) {
    $r = Call-Tool -Tool "mem_brief_pull" -Args @{ agent_name = $agent; limit = 5 }
    $briefs = @()
    if ($r) {
      if ($r.result -and $r.result.briefs) { $briefs = $r.result.briefs }
      elseif ($r.briefs)                   { $briefs = $r.briefs }
    }
    foreach ($b in $briefs) {
      $block = "`n--- BRIEF id=$($b.id) from=$($b.source_agent) ch=$($b.channel) at=$($b.created_at) ---`n$($b.content)`n--- BRIEF END ---`n"
      $ok = Send-ToWindow -Title $agent -Text $block
      if ($ok) { Write-Host "[$(Get-Date -Format HH:mm:ss)] dispatched id=$($b.id) -> $agent ($($b.content.Length)B)" }
    }
  }
  Start-Sleep -Seconds $PullSeconds
}
