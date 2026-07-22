# Provider separation completion acceptance

Run this from a clean temporary worktree. These checks are PowerShell-only and do not read `auth.json`, make a Grok request, mutate `current.json`, or delete legacy assets.

```powershell
$root = (Resolve-Path .).Path
$pointer = Get-Content -Raw "$env:LOCALAPPDATA\GrokWorkerProvider\current.json" | ConvertFrom-Json
$manifest = Get-Content -Raw (Join-Path $pointer.releasePath 'release-manifest.json') | ConvertFrom-Json
$commit = $manifest.sourceCommit
git show-ref --verify --quiet refs/heads/main
if ($LASTEXITCODE -ne 0) { throw 'S1 FAIL: main is absent' }
git merge-base --is-ancestor $commit main
if ($LASTEXITCODE -ne 0) { throw "S1 FAIL: main lacks $commit" }
if (-not (git tag --contains $commit)) { throw 'S1 FAIL: deployed commit has no tag' }
if (git status --porcelain=v1 --untracked-files=all) { throw 'S1 FAIL: worktree is not clean' }
```

```powershell
$runtimeFiles = @('lib/provider.js','lib/availability.js','bin/grok-worker.js','grok-worker.cmd') | ForEach-Object { Join-Path $root $_ }
if (Select-String -LiteralPath $runtimeFiles -Pattern 'grok-bridge|GrokUI[\\/]+worker-(provider|profiles)' -CaseSensitive:$false) { throw 'S2 FAIL: runtime coupling found' }
if (Select-String -Path (Join-Path $pointer.releasePath 'lib/*.js') -Pattern 'grok-bridge|GrokUI[\\/]+worker-(provider|profiles)' -CaseSensitive:$false) { throw 'S2 FAIL: release coupling found' }
if ($pointer.dataRoot -match 'GrokUI' -or $pointer.registryPath -match 'GrokUI' -or $pointer.approvedProfileRoot -match 'GrokUI') { throw 'S5 FAIL: active roots are not Provider-owned' }
```

```powershell
$out = Join-Path ([IO.Path]::GetTempPath()) ('grok-worker-provider-release-' + [guid]::NewGuid())
./tools/New-GrokWorkerProviderRelease.ps1 -Version "candidate-$($commit.Substring(0,12))" -OutputRoot $out
./tools/Test-GrokWorkerProviderRelease.ps1 -ReleasePath $out
```

The release scripts use a fixed allowlist and never set `current.json`; only G9, after independent audit and explicit authorization, may publish or switch it.
