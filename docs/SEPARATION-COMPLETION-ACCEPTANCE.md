# Grok Worker Provider separation completion acceptance

This is the release-acceptance procedure for the Provider authority repository.
It is intentionally PowerShell-only.  It never reads, copies, hashes, or prints
`auth.json`; makes no Grok request; never writes `current.json`; and never
deletes or archives a legacy asset.  A normal Grok UI consumer root is allowed:
the failure condition is a direct source, release, scheduler, data-root, or
registry dependency on Grok UI.

Run the commands from a clean, temporary, detached worktree made from the
candidate tag.  Do not run S1--S7 as authorization to create that tag, switch
the machine release, or remove the temporary worktree.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath .).Path
$pointerPath = Join-Path $env:LOCALAPPDATA 'GrokWorkerProvider\current.json'
$pointerBefore = Get-FileHash -LiteralPath $pointerPath -Algorithm SHA256
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$manifestPath = Join-Path $pointer.releasePath 'release-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$deployedCommit = [string]$manifest.sourceCommit
if ($deployedCommit -notmatch '^[0-9a-f]{40}$') { throw 'S0 FAIL: deployed manifest sourceCommit is invalid.' }
if ($pointer.dataRoot -match 'GrokUI' -or $pointer.registryPath -match 'GrokUI' -or $pointer.approvedProfileRoot -match 'GrokUI') { throw 'S0 FAIL: active Provider roots are not neutral.' }
```

## S1 -- source and Git governance

The deployed manifest is the dynamic source of the deployed commit; no commit
literal is permitted.  The candidate must have a `main` ancestor, an immutable
tag, a clean temporary worktree, and clean tracked documentation.

```powershell
& git -C $root show-ref --verify --quiet refs/heads/main
if ($LASTEXITCODE -ne 0) { throw 'S1 FAIL: main is absent.' }
& git -C $root merge-base --is-ancestor $deployedCommit main
if ($LASTEXITCODE -ne 0) { throw "S1 FAIL: main does not contain deployed commit $deployedCommit." }
$deployedTags = @(& git -C $root tag --contains $deployedCommit)
if ($deployedTags.Count -eq 0) { throw "S1 FAIL: deployed commit $deployedCommit has no tag." }
$headTag = @(& git -C $root tag --points-at HEAD)
if ($headTag.Count -eq 0) { throw 'S1 FAIL: candidate HEAD is not tagged.' }
$branch = & git -C $root symbolic-ref -q --short HEAD
if ($LASTEXITCODE -eq 0 -or $branch) { throw 'S1 FAIL: candidate must be a detached temporary worktree.' }
$dirty = @(& git -C $root status --porcelain=v1 --untracked-files=all)
if ($dirty.Count -ne 0) { throw 'S1 FAIL: temporary worktree is not clean.' }
$trackedDocs = @(& git -C $root ls-files docs)
if ($trackedDocs.Count -eq 0) { throw 'S1 FAIL: no tracked documentation was found.' }
foreach ($doc in $trackedDocs) { if (-not (Test-Path -LiteralPath (Join-Path $root $doc) -PathType Leaf)) { throw "S1 FAIL: tracked doc is missing: $doc" } }
```

To create the prescribed inspection-only temporary worktree after a tag has
already been authorized and created, use the following command.  It is not to
be executed during feature development.

```powershell
$candidateTag = 'REPLACE_WITH_AUTHORIZED_TAG'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('grok-worker-provider-audit-' + [guid]::NewGuid())
& git -C 'D:\Grok Worker Provider' worktree add --detach $temporaryRoot $candidateTag
if ($LASTEXITCODE -ne 0) { throw 'S1 FAIL: could not create temporary tagged worktree.' }
```

## S2 -- no Grok UI runtime coupling

This gate distinguishes a permitted caller of the stable `grok-worker.cmd`
shim from forbidden Provider ownership/coupling.  It scans tracked and
untracked Provider source, every release file, and reverse dependencies in
consumer roots.  Schema `$id` strings and historical explanatory docs are not
runtime evidence, so only executable/runtime paths are examined for a direct
path hit.

```powershell
$runtimeRelative = @('bin/grok-worker.js','grok-worker.cmd','lib/provider.js','lib/availability.js','lib/hook-boundary.js','deploy/install-maintenance-task.ps1')
$runtimeFiles = $runtimeRelative | ForEach-Object { Join-Path $root $_ }
$forbiddenRuntime = 'grok-bridge|GrokUI[\\/]+worker-(provider|profiles|codex-grok-workers)|D:[\\/]Grok UI[\\/]\.codex[\\/]grok-bridge[\\/]provider'
$sourceHits = Select-String -LiteralPath $runtimeFiles -Pattern $forbiddenRuntime -CaseSensitive:$false
if ($sourceHits) { throw "S2 FAIL: Provider runtime path couples to Grok UI: $($sourceHits.Path -join ', ')" }

$untrackedRuntime = @(& git -C $root ls-files --others --exclude-standard -- 'bin/*' 'lib/*' 'deploy/*' '*.cmd')
foreach ($relative in $untrackedRuntime) {
  $candidate = Join-Path $root $relative
  if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Select-String -LiteralPath $candidate -Pattern $forbiddenRuntime -CaseSensitive:$false)) { throw "S2 FAIL: untracked runtime coupling: $relative" }
}

$releaseRuntime = @('bin/grok-worker.js','grok-worker.cmd','lib/provider.js','lib/availability.js','lib/hook-boundary.js','deploy/install-maintenance-task.ps1') | ForEach-Object { Join-Path $pointer.releasePath $_ }
$releaseHits = Select-String -LiteralPath $releaseRuntime -Pattern $forbiddenRuntime -CaseSensitive:$false
if ($releaseHits) { throw 'S2 FAIL: deployed release runtime couples to Grok UI.' }

$consumerRoots = @(& "$env:USERPROFILE\.local\bin\grok-worker.cmd" roots list --json | ConvertFrom-Json).roots
foreach ($consumer in $consumerRoots) {
  if (-not (Test-Path -LiteralPath $consumer.path -PathType Container)) { continue }
  $calls = Get-ChildItem -LiteralPath $consumer.path -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.js','.ps1','.cmd','.json' }
  foreach ($call in $calls) {
    $hits = Select-String -LiteralPath $call.FullName -Pattern 'grok-bridge[\\/]provider|GrokUI[\\/]worker-(provider|profiles)|GROK_WORKER_(DATA_ROOT|PROFILES|APPROVED_PROFILE_ROOT)' -CaseSensitive:$false
    if ($hits) { throw "S2 FAIL: consumer has a forbidden reverse dependency: $($call.FullName)" }
  }
}
```

## S3 -- documentation inventory

The documentation list is discovered dynamically, then reconciled with Git so
that a fixed historical list cannot give a false pass.

```powershell
$allDocs = Get-ChildItem -LiteralPath (Join-Path $root 'docs') -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\','/') } | Sort-Object
$trackedDocs = @(& git -C $root ls-files docs | Sort-Object)
$untrackedDocs = @(& git -C $root ls-files --others --exclude-standard docs | Sort-Object)
[pscustomobject]@{ tracked = $trackedDocs; untracked = $untrackedDocs; discovered = $allDocs } | ConvertTo-Json -Depth 4
if (Compare-Object $trackedDocs $allDocs) { throw 'S3 FAIL: documentation disk/Git inventory differs.' }
if ($untrackedDocs.Count -ne 0) { throw 'S3 FAIL: untracked documentation remains.' }
```

## S4 -- reproducible immutable release candidate

The builder has a fixed allowlist, canonical hash, and no operation that writes
the current pointer.  It must run from the tagged detached temporary worktree,
then a second build must produce the same canonical hash.  A builder failure is
not permitted to switch `current.json`.

```powershell
$outA = Join-Path ([IO.Path]::GetTempPath()) ('grok-worker-provider-release-a-' + [guid]::NewGuid())
$outB = Join-Path ([IO.Path]::GetTempPath()) ('grok-worker-provider-release-b-' + [guid]::NewGuid())
$version = 'candidate-' + ((& git -C $root rev-parse --short=12 HEAD).Trim())
& (Join-Path $root 'tools\New-GrokWorkerProviderRelease.ps1') -Version $version -OutputRoot $outA -SourceRoot $root -RequireTaggedSource
if ($LASTEXITCODE -ne 0) { throw 'S4 FAIL: first build failed.' }
& (Join-Path $root 'tools\New-GrokWorkerProviderRelease.ps1') -Version $version -OutputRoot $outB -SourceRoot $root -RequireTaggedSource
if ($LASTEXITCODE -ne 0) { throw 'S4 FAIL: second build failed.' }
$a = & (Join-Path $root 'tools\Test-GrokWorkerProviderRelease.ps1') -ReleasePath $outA
$b = & (Join-Path $root 'tools\Test-GrokWorkerProviderRelease.ps1') -ReleasePath $outB
if ($a.filesSha256 -ne $b.filesSha256) { throw 'S4 FAIL: rebuild hash differs.' }
if ((Get-FileHash -LiteralPath $pointerPath -Algorithm SHA256).Hash -ne $pointerBefore.Hash) { throw 'S4 FAIL: current pointer changed during candidate build.' }
```

## S5 -- active roots, archive manifests, and unmarked residue

Active Provider roots, an explicitly manifested legacy archive, and unmarked
legacy residue are three different conditions.  This gate only reads metadata
and non-auth file names; it does not traverse or inspect any `auth.json`.

```powershell
if ($pointer.dataRoot -notmatch 'GrokWorkerProvider' -or $pointer.registryPath -notmatch 'GrokWorkerProvider' -or $pointer.approvedProfileRoot -notmatch 'GrokWorkerProvider') { throw 'S5 FAIL: active roots are not Provider-owned.' }
$legacyInventory = Join-Path $root 'docs\audits\legacy-grok-ui-provider-inventory.md'
if (-not (Test-Path -LiteralPath $legacyInventory -PathType Leaf)) { throw 'S5 FAIL: legacy inventory is missing.' }
$legacyCode = 'D:\Grok UI\.codex\grok-bridge\provider'
$legacyRoots = @($legacyCode, (Join-Path $env:LOCALAPPDATA 'GrokUI\worker-provider'), (Join-Path $env:LOCALAPPDATA 'GrokUI\worker-profiles'), (Join-Path $env:LOCALAPPDATA 'GrokUI\codex-grok-workers'))
foreach ($legacy in $legacyRoots) {
  if (-not (Test-Path -LiteralPath $legacy)) { continue }
  $manifest = Join-Path $legacy 'archive-manifest.json'
  if (Test-Path -LiteralPath $manifest -PathType Leaf) { Write-Output "S5 ARCHIVED-MANIFEST: $legacy" }
  else { Write-Warning "S5 UNMARKED-RESIDUE (no action authorized): $legacy" }
}
```

## S6 -- neutral entrypoint and profile safety

```powershell
$shim = Join-Path $env:USERPROFILE '.local\bin\grok-worker.cmd'
if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) { throw 'S6 FAIL: stable shim is absent.' }
$task = Get-ScheduledTask -TaskName 'GrokWorkerProviderMaintenance' -ErrorAction Stop
if (($task.Actions | Out-String) -notmatch [regex]::Escape($shim)) { throw 'S6 FAIL: scheduler does not call the stable Provider shim.' }
$doctor = & $shim doctor --json | ConvertFrom-Json
if (-not $doctor.ok) { throw 'S6 FAIL: Provider doctor failed.' }
$roots = & $shim roots inspect --json | ConvertFrom-Json
if ($roots.dataRoot -match 'GrokUI' -or $roots.registryPath -match 'GrokUI' -or $roots.approvedProfileRoot -match 'GrokUI') { throw 'S6 FAIL: roots inspect found a Grok UI active root.' }
```

## S7 -- transaction behavior and zero-request regression

```powershell
Push-Location $root
try {
  & npm.cmd test; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: provider harness failed.' }
  & npm.cmd run test:mutation; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: mutation harness failed.' }
  & npm.cmd run test:maintenance-plan; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: maintenance plan mutation harness failed.' }
  & npm.cmd run test:availability; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: availability harness failed.' }
  & npm.cmd run test:global; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: global pool harness failed.' }
  & npm.cmd run test:r8; if ($LASTEXITCODE -ne 0) { throw 'S7 FAIL: r8 transaction harness failed.' }
} finally { Pop-Location }
if ((Get-FileHash -LiteralPath $pointerPath -Algorithm SHA256).Hash -ne $pointerBefore.Hash) { throw 'S7 FAIL: current pointer changed during zero-request regression.' }
Write-Output 'ACCEPTANCE PASS: only after every S0-S7 check succeeds and an independent audit records PASS.'
```

G9 remains a separately authorized operation: only after independent PASS may
an authorized controller merge `main`, create a tag, publish an immutable
release, pause and inspect maintenance, atomically switch `current.json`, run
zero-request health checks, and restore the scheduled task.  This procedure is
not that authorization.
