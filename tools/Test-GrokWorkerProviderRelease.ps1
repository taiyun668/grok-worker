[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ReleasePath,
  [string] $ExpectedFilesSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-Sha256([string] $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-BytesSha256([byte[]] $Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

$ReleasePath = (Resolve-Path -LiteralPath $ReleasePath).Path
$manifestPath = Join-Path $ReleasePath 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'release-manifest.json is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.sourceDirty -ne $false -or [string]$manifest.sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'Release manifest provenance is invalid.' }
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
$actual = Get-ChildItem -LiteralPath $ReleasePath -File -Recurse | ForEach-Object { $_.FullName.Substring($ReleasePath.Length + 1).Replace('\','/') } | Sort-Object
$expected = @($allowlist + 'release-manifest.json' | Sort-Object)
if (Compare-Object $actual $expected) { throw 'Release file set differs from canonical allowlist.' }
foreach ($schema in $allowlist | Where-Object { $_ -like 'schemas/*.json' }) { Get-Content -LiteralPath (Join-Path $ReleasePath $schema) -Raw | ConvertFrom-Json | Out-Null }
foreach ($relative in $allowlist) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path $ReleasePath $relative))
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $utf8.GetString($bytes) } catch { throw "Release file is not canonical UTF-8 text: $relative" }
  if ($text.Contains("`r")) { throw "Release file has non-canonical line endings: $relative" }
}
$entries = foreach ($relative in ($allowlist | Sort-Object)) { [ordered]@{ path = $relative; sha256 = Get-Sha256 (Join-Path $ReleasePath $relative) } }
$canonical = [Text.Encoding]::UTF8.GetBytes(($entries | ConvertTo-Json -Compress -Depth 3))
$actualHash = Get-BytesSha256 $canonical
if ($actualHash -ne [string]$manifest.filesSha256) { throw 'Manifest filesSha256 does not match release contents.' }
if ($ExpectedFilesSha256 -and $actualHash -ne $ExpectedFilesSha256.ToLowerInvariant()) { throw 'Release hash differs from ExpectedFilesSha256.' }
$runtimeHits = Select-String -LiteralPath (Join-Path $ReleasePath 'lib/provider.js'), (Join-Path $ReleasePath 'lib/availability.js'), (Join-Path $ReleasePath 'lib/locks.js'), (Join-Path $ReleasePath 'bin/grok-worker.js') -Pattern 'grok-bridge|GrokUI[\\/]+worker-(provider|profiles)' -CaseSensitive:$false
if ($runtimeHits) { throw 'Release runtime contains a Grok UI dependency path.' }
[pscustomobject]@{ pass = $true; releasePath = $ReleasePath; fileCount = $allowlist.Count; filesSha256 = $actualHash; sourceCommit = $manifest.sourceCommit; currentChanged = $false }
