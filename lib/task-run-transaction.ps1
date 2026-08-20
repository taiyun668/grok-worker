[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $WalPath,
  [Parameter(Mandatory)] [string] $DesiredPath,
  [Parameter(Mandatory)] [long] $ExpectedRevision,
  [string] $ExpectedStatus,
  [long] $ExpectedOwnerPid = 0,
  [string] $ExpectedOwnerStartTicks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Set-Failure([string] $Code, [string] $Message) {
  $exception = [InvalidOperationException]::new($Message)
  $exception.Data['ProviderCode'] = $Code
  throw $exception
}

function Write-AtomicUtf8Json([string] $Path, [object] $Value) {
  $directory = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temp = Join-Path $directory ((Split-Path -Leaf $Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  $json = ($Value | ConvertTo-Json -Depth 100) + "`n"
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream = [IO.FileStream]::new($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  try {
    if ([IO.File]::Exists($Path)) {
      $backup = $Path + '.' + [guid]::NewGuid().ToString('N') + '.bak'
      try { [IO.File]::Replace($temp, $Path, $backup) }
      finally { if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) } }
    }
    else { [IO.File]::Move($temp, $Path) }
  } finally {
    if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
  }
}

$mutex = $null
$held = $false
try {
  $normalized = [IO.Path]::GetFullPath($WalPath).ToUpperInvariant()
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)))).Replace('-', '') }
  finally { $algorithm.Dispose() }
  $mutex = [Threading.Mutex]::new($false, "Global\GrokWorkerProvider.TaskRun.$hash")
  try { $held = $mutex.WaitOne([TimeSpan]::FromSeconds(10)) }
  catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { Set-Failure 'TASK_RUN_LOCKED' 'Task-run transaction mutex timed out.' }

  $desired = Get-Content -LiteralPath $DesiredPath -Raw | ConvertFrom-Json
  $current = $null
  if ([IO.File]::Exists($WalPath)) { $current = Get-Content -LiteralPath $WalPath -Raw | ConvertFrom-Json }
  $actualRevision = if ($null -eq $current) { 0 } else { [long]$current.revision }
  if ($actualRevision -ne $ExpectedRevision) { Set-Failure 'TASK_RUN_CAS_CONFLICT' 'Task-run revision changed before commit.' }
  if ($null -ne $current -and @('completed','failed','interrupted') -contains [string]$current.status) {
    Set-Failure 'TASK_RUN_TERMINAL_CONFLICT' 'A terminal task-run record is immutable.'
  }
  if ($ExpectedStatus -and ($null -eq $current -or [string]$current.status -ne $ExpectedStatus)) {
    Set-Failure 'TASK_RUN_CAS_CONFLICT' 'Task-run status changed before commit.'
  }
  if ($ExpectedOwnerPid -gt 0) {
    $ownerMismatch = ($null -eq $current) -or ($null -eq $current.owner) -or ([long]$current.owner.pid -ne $ExpectedOwnerPid) -or ([string]$current.owner.processStartTicks -ne $ExpectedOwnerStartTicks)
    if ($ownerMismatch) {
      Set-Failure 'TASK_RUN_CAS_CONFLICT' 'Task-run owner identity changed before commit.'
    }
  }

  $desired.revision = $ExpectedRevision + 1
  $desired.updatedAt = [DateTime]::UtcNow.ToString('o')
  Write-AtomicUtf8Json -Path $WalPath -Value $desired
  [ordered]@{ ok = $true; record = $desired } | ConvertTo-Json -Depth 100 -Compress
  exit 0
} catch {
  $code = if ($_.Exception.Data.Contains('ProviderCode')) { [string]$_.Exception.Data['ProviderCode'] } else { 'TASK_RUN_TRANSACTION_FAILED' }
  [ordered]@{ ok = $false; code = $code; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress
  exit 2
} finally {
  if ($held -and $null -ne $mutex) { try { $mutex.ReleaseMutex() } catch { } }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
