# Legacy Grok UI Provider inventory

Captured read-only on 2026-07-21 Pacific time. This is a provenance inventory, not a deletion authorization.

| Item | Value |
| --- | --- |
| Legacy embedding | `D:\Grok UI\.codex\grok-bridge\provider` |
| Non-auth file count | 35 |
| Canonical file manifest SHA-256 | `520fc4dd35a28d6dafca1cd33efa6d18b671fee9bd8736b9e2f5c78667f1dcf3` |
| Active Provider entrypoint | `%USERPROFILE%\.local\bin\grok-worker.cmd` |
| Active roots | `%LOCALAPPDATA%\GrokWorkerProvider\...` |

The canonical manifest is UTF-8 JSON of sorted `{path,bytes,sha256}` entries. `auth.json` is excluded before hashing and is never read, copied, linked, printed, or moved.

The old directories below exist only as inert residues; `grok-worker doctor` confirms current roots are Provider-owned:

- `%LOCALAPPDATA%\GrokUI\worker-provider` (26 non-auth top-level entries)
- `%LOCALAPPDATA%\GrokUI\worker-profiles` (2 non-auth top-level entries)
- `%LOCALAPPDATA%\GrokUI\codex-grok-workers` (7 non-auth top-level entries)

No deletion or archival action has been performed. After a separate explicit authorization that names these exact targets, the owner may use a recoverable archive workflow for the first directory and individually approved credential-safe handling for the latter two. Do not run a blanket recursive command and do not process any `auth.json`.

The exact, non-executed archive command prepared for the code-only embedding is:

```powershell
$source = 'D:\Grok UI\.codex\grok-bridge\provider'
$archiveRoot = 'D:\Grok Worker Provider-legacy-archive'
$destination = Join-Path $archiveRoot 'provider-20260721'
if (Test-Path -LiteralPath $source) {
  if (Test-Path -LiteralPath $destination) { throw "Archive destination exists: $destination" }
  New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
  Move-Item -LiteralPath $source -Destination $destination
}
```

Do not execute that command until explicitly authorized. No equivalent command is prepared for the three legacy data/profile roots because they may contain credential material; any archival or deletion there requires an exact user authorization and must exclude `auth.json` without inspecting it.
