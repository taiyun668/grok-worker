# Wrapper invoked by the "GrokWorkerProvider-CCSwitchExport" scheduled task
# (runs every 1 minute). Runs export.mjs --write and appends output to a
# daily log file; prunes log files older than the retention window so this
# can run indefinitely without growing unbounded (export.mjs itself applies
# the same daily-backup + retention policy to the CC Switch DB backups).

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logsDir = Join-Path $scriptDir 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

$dateStamp = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $logsDir "export-$dateStamp.log"
$retentionDays = 30

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Value "---- $timestamp ----"

# Suppress node's benign "SQLite is experimental" warning at the source
# instead of fighting PowerShell's native-command stderr stream semantics
# (merging a native exe's stderr via 2>&1 wraps each line as a
# NativeCommandError and can trip $ErrorActionPreference='Stop' even on
# exit code 0 — avoided entirely by not emitting the warning in the first place).
$env:NODE_NO_WARNINGS = '1'

$exportScript = Join-Path $scriptDir 'export.mjs'
try {
  $output = node $exportScript --write
  Add-Content -Path $logFile -Value $output
  Add-Content -Path $logFile -Value "exit code: $LASTEXITCODE"
} catch {
  Add-Content -Path $logFile -Value "SCRIPT ERROR: $($_.Exception.Message)"
}

# Prune log files older than retention window.
Get-ChildItem -Path $logsDir -Filter 'export-*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$retentionDays) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
