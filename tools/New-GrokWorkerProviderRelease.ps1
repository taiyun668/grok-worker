[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9._+-]+$')] [string] $Version,
  [Parameter(Mandatory)] [string] $OutputRoot,
  [string] $SourceRoot,
  [switch] $RequireTaggedSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git([string[]] $Arguments) {
  $text = & git -C $SourceRoot @Arguments
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed" }
  return ($text | Out-String).Trim()
}
function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-BytesSha256([byte[]] $Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Copy-CanonicalText([string] $Source, [string] $Target) {
  # The release allowlist is deliberately text-only.  Normalizing line endings
  # here makes a release byte-identical when Git checks the same commit out
  # with different CRLF policies in separate worktrees.
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = [IO.File]::ReadAllText($Source, $utf8) }
  catch { throw "Release allowlist source is not valid UTF-8 text: $Source" }
  $canonical = $text.Replace("`r`n", "`n").Replace("`r", "`n")
  [IO.File]::WriteAllText($Target, $canonical, [Text.UTF8Encoding]::new($false))
}

if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw "OutputRoot already exists: $OutputRoot" }
if ((Invoke-Git @('status','--porcelain=v1','--untracked-files=all'))) { throw 'SourceRoot must be a clean Git worktree.' }
$sourceCommit = Invoke-Git @('rev-parse','HEAD')
$sourceCommitTime = Invoke-Git @('show','-s','--format=%cI',$sourceCommit)
$packageVersion = (Get-Content -LiteralPath (Join-Path $SourceRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($packageVersion -ne $Version) { throw "Package version '$packageVersion' does not match requested version '$Version'." }
if ($RequireTaggedSource) {
  $branch = & git -C $SourceRoot symbolic-ref -q --short HEAD
  if ($LASTEXITCODE -eq 0 -or $branch) { throw 'RequireTaggedSource requires a detached temporary worktree.' }
  $tags = @((Invoke-Git @('tag','--points-at','HEAD')) -split "`r?`n" | Where-Object { $_ })
  if ($tags -notcontains "v$Version") { throw "RequireTaggedSource requires exact tag v$Version at HEAD." }
}

$allowlist = @(
  'bin/grok-worker.js', 'deploy/GrokWorkerProviderMaintenance.template.xml', 'deploy/install-maintenance-task.ps1', 'grok-worker.cmd',
  'lib/availability.js', 'lib/doctor.js', 'lib/hook-boundary.js', 'lib/locks.js', 'lib/provider.js', 'lib/task-run-transaction.ps1',
  'package.json', 'README.md', 'README.en.md', 'docs/KNOWN-GAPS.md', 'docs/QUICKSTART.en.md',
  'schemas/availability.provider.v5.schema.json', 'schemas/command-plan.provider.v3.schema.json', 'schemas/current-pointer.v5.schema.json',
  'schemas/deploy-pointer.v6.schema.json', 'schemas/maintenance-profile.v6.schema.json', 'schemas/maintenance-result.v6.schema.json',
  'schemas/maintenance-run.v6.schema.json', 'schemas/maintenance-task.v6.schema.json', 'schemas/pool-config.v6.schema.json',
  'schemas/profile-registry.provider.v3.schema.json', 'schemas/provider-health.v5.schema.json', 'schemas/rate-window.v6.schema.json',
  'schemas/result-capsule.provider.v3.schema.json', 'schemas/task-capsule.provider.v3.schema.json', 'schemas/task-run.provider.v5.schema.json',
  'schemas/task-run.provider.v6.schema.json',
  'schemas/usage-ledger.provider.v3.schema.json', 'schemas/usage-ledger.provider.v4.schema.json'
)

New-Item -ItemType Directory -Path $OutputRoot | Out-Null
foreach ($relative in $allowlist) {
  $source = Join-Path $SourceRoot $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release allowlist source is missing: $relative" }
  $target = Join-Path $OutputRoot $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-CanonicalText $source $target
}
$entries = foreach ($relative in ($allowlist | Sort-Object)) {
  [ordered]@{ path = $relative; sha256 = Get-Sha256 (Join-Path $OutputRoot $relative) }
}
$canonical = [Text.Encoding]::UTF8.GetBytes(($entries | ConvertTo-Json -Compress -Depth 3))
$filesSha256 = Get-BytesSha256 $canonical
$manifest = [ordered]@{
  schemaVersion = 1
  version = $Version
  sourceCommit = $sourceCommit
  sourceDirty = $false
  fileCount = $allowlist.Count
  filesSha256 = $filesSha256
  sha256 = $filesSha256
  canonicalization = 'UTF-8 JSON of sorted release-relative path/SHA-256 entries, excluding this manifest'
  generatedAt = $sourceCommitTime
}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'release-manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ releasePath = $OutputRoot; version = $Version; sourceCommit = $sourceCommit; fileCount = $allowlist.Count; filesSha256 = $filesSha256; taggedSourceRequired = [bool]$RequireTaggedSource; currentChanged = $false }
