# r8-rc2 baseline evidence

Captured before source modification on 2026-07-21 Pacific time.

- Deployed pointer version: `1.0.0-provider-root-separation-20260722-r2`.
- Deployed release manifest: source commit `f377250e8355c1274abcfb6321fc036afc754543`, `sourceDirty:false`, 26 files, canonical files SHA-256 `94e383deba44d26e2b68137c2ab6b50ad18fb673b5751dd210fa3395e8db14aa`.
- Feature worktree: `D:\Grok Worker Provider-r8-rc2`, branch `codex/availability-v6-r8-transaction-rc2`, created directly from the manifest source commit and clean at creation.
- The stable shim, pointer, scheduler action, data root, registry root, and approved profile root resolve under `GrokWorkerProvider`; neither scheduler nor pointer was modified.
- Baseline code confirms the two repair targets: `executeMaintenanceProbe` does not call the complete `verifyPlanContract`, and the maintenance tick reserves its rate slot before persisting a complete intent transaction.

This is evidence, not release acceptance. No credentials were read and no maintenance probe was requested.
