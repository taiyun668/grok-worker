[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $WalPath,
  [Parameter(Mandatory)] [string] $DesiredPath,
  [Parameter(Mandatory)] [long] $ExpectedRevision,
  [string] $ExpectedStatus,
  [long] $ExpectedOwnerPid = 0,
  [string] $ExpectedOwnerStartTicks,
  [ValidateRange(0, 5000)] [int] $TestHoldAfterReadMilliseconds = 0,
  [string] $TestReadyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class GrokWorkerPathIdentity {
  private const uint FILE_READ_ATTRIBUTES = 0x80;
  private const uint FILE_SHARE_READ = 0x1;
  private const uint FILE_SHARE_WRITE = 0x2;
  private const uint FILE_SHARE_DELETE = 0x4;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string name, uint access, uint share, IntPtr security, uint creation,
    uint flags, IntPtr template);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(
    SafeFileHandle handle, StringBuilder path, uint chars, uint flags);

  public static string FinalPath(string path) {
    using (SafeFileHandle handle = CreateFileW(
      path, FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
      return buffer.ToString();
    }
  }
}
'@

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

function Get-TaskRunCanonicalPath([string] $Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.File]::Exists($full)) {
    $physical = [GrokWorkerPathIdentity]::FinalPath($full)
  } else {
    $parent = Split-Path -Parent $full
    if (-not [IO.Directory]::Exists($parent)) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $physicalParent = [GrokWorkerPathIdentity]::FinalPath($parent)
    $separator = if ($physicalParent.EndsWith('\')) { '' } else { '\' }
    $physical = $physicalParent + $separator + [IO.Path]::GetFileName($full)
  }
  if ($physical.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $physical = '\\' + $physical.Substring(8)
  } elseif ($physical.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $physical = $physical.Substring(4)
  }
  return $physical.Replace('/', '\')
}

$mutex = $null
$held = $false
try {
  $canonicalWalPath = Get-TaskRunCanonicalPath $WalPath
  $mutexPreimage = $canonicalWalPath.ToUpperInvariant()
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($mutexPreimage)))).Replace('-', '') }
  finally { $algorithm.Dispose() }
  $mutex = [Threading.Mutex]::new($false, "Global\GrokWorkerProvider.TaskRun.$hash")
  try { $held = $mutex.WaitOne([TimeSpan]::FromSeconds(10)) }
  catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { Set-Failure 'TASK_RUN_LOCKED' 'Task-run transaction mutex timed out.' }

  $desired = Get-Content -LiteralPath $DesiredPath -Raw | ConvertFrom-Json
  $current = $null
  if ([IO.File]::Exists($canonicalWalPath)) { $current = Get-Content -LiteralPath $canonicalWalPath -Raw | ConvertFrom-Json }
  if ($TestHoldAfterReadMilliseconds -gt 0) {
    if ($env:GROK_WORKER_PROVIDER_TEST_MODE -ne '1' -or -not $TestReadyPath) {
      Set-Failure 'TASK_RUN_TEST_HOOK_REFUSED' 'Task-run transaction test hook requires explicit test mode and ready path.'
    }
    [IO.File]::WriteAllText($TestReadyPath, 'ready', [Text.UTF8Encoding]::new($false))
    Start-Sleep -Milliseconds $TestHoldAfterReadMilliseconds
  }
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
  Write-AtomicUtf8Json -Path $canonicalWalPath -Value $desired
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
