param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $HookArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Hook = Join-Path $ScriptDir "firm-runtime-hook.js"
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..\..")
$DefaultEnvFile = Join-Path $RepoRoot ".mnemo-hook.env"
$EnvFile = if ($env:MNEMO_HOOK_ENV_FILE) { $env:MNEMO_HOOK_ENV_FILE } else { $DefaultEnvFile }

if (Test-Path -LiteralPath $EnvFile) {
  Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line -match "=") {
      $name, $value = $line.Split("=", 2)
      $name = $name.Trim()
      $value = $value.Trim().Trim('"').Trim("'")
      if ($name) { Set-Item -Path "Env:$name" -Value $value }
    }
  }
}

if (-not $env:MNEMO_PROJECT_ALIASES_FILE) {
  $LocalAliases = Join-Path $RepoRoot ".mnemo-project-aliases.json"
  if (Test-Path -LiteralPath $LocalAliases) {
    $env:MNEMO_PROJECT_ALIASES_FILE = $LocalAliases
  }
}

node $Hook @HookArgs
exit $LASTEXITCODE
