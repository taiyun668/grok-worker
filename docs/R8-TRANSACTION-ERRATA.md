# v6-r8 narrow implementation errata

Status: implementation-controlled clarification for the `codex/availability-v6-r8-transaction-rc2` branch. This document is intentionally narrow; it does not reopen r2-r7 or alter product scope.

## Pointer schema correction

`schemas/deploy-pointer.v6.schema.json` requires `approvedProfileRoot`. Section 3.9 of `AVAILABILITY-LAYER.v6-early-reset.r8.md` omitted that required field. The v6 deploy pointer contract therefore requires all of:

- `version`, `releasePath`, `previousVersion`, `dataRoot`, `registryPath`, `approvedProfileRoot`, `schemaVersions`, `manifestSha256`, and `updatedAt`;
- the three root fields to resolve under the Provider-owned root; and
- validation to fail closed when any required root is absent or malformed.

## Maintenance execution boundary

Immediately before the sole maintenance spawn, a complete maintenance-specific verifier must validate the concrete executable, argv, environment, permission settings, and filesystem boundaries. It must reject any missing or substituted requirement: verified profile CLI; isolated `GROK_HOME`; no default `.grok`; `--no-plan`; `--no-memory`; `grok-4.5`; high reasoning; `--max-turns 1`; `dontAsk`; empty allow list; whole-tool Bash plus MCP/Web denies; isolated `HOME`, `USERPROFILE`, `LOCALAPPDATA`, session, and socket; compatibility hooks disabled; scratch-only cwd; and no plan path that can read `auth.json`.

## Two transactions and recovery

For each probe, both availability and sidecar targets, including final revisions, timestamps, and `availabilityRevisionSeen`, are fixed before the first intent WAL is fsynced. The order is: intent WAL, durable rate-slot reservation, availability CAS, sidecar CAS, then request-started WAL and the one permitted spawn.

The result is persisted and redacted before a second complete intent. Missing usage is the v4 unknown form (`present:false`, null numeric fields, `unknown:true`) and never becomes zero. The second transaction applies the classified outcome and synchronizes `availabilityRevisionSeen` to the final availability revision.

Recovery compares every target file exactly with its recorded `before` and `target`: `target` is committed, `before` is safely forwardable, and any other state is a third-party advance that becomes terminal `interrupted` without overwrite or replay. A request-started transaction is never replayed.
