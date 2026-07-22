# v6 增补:自动早重置恢复（Early-Reset Auto-Recovery）

> 基于已通过并施工的 v5（`AVAILABILITY-LAYER.plan.v5.md`）。本增补只加"自动早重置恢复"，不改 v5 核心状态机、锁生命周期、归因边界。
> Owner 硬约束（2026-07-21）：① quota 冻结退避**上限 4 小时**；② **必须自动，不依赖人工触发**（前提，非可选）。
> 定稿日期：2026-07-21

## 0. 要解决的问题
官方偶尔在周期结束前给"额外/提前重置"，最近频繁。v5 靠 `resetAt:null` + 指数退避重探，**理论上能发现**早重置，但：
- 退避涨到 24h 上限 → 发现慢；
- 默认 `probePolicy=disabled` → 根本不自动探；
- `when-no-active` → 池里还有 active 时，冻结账号永不被自动救；
- 计费日志的额度恢复信号（零请求）未接成触发器。
→ 对"频繁早重置"，v5 实际做不到**及时且自动**恢复。

## 1. 设计原则（守 v5 安全纪律）
- **计费日志只作触发器，永不作权威**：只有一次**真实探针成功**才授 `active`。
- **零请求信号优先，真实探针兜底**：先用免费的计费读命中，再用有界的盲探兜底，把浪费的真实请求压到最低。
- 每次真实探针仍有独立 Capsule/Result/usage、单飞、全局频率上限。
- "自动"的授权来自**一次性 pool 级配置**（开一次，之后自动），不是每任务 probePolicy，也不是人工 `pool refresh`。

## 2. 改动项

### E-1 quota 退避上限 24h → 4h
- `computeNextProbeAt` 对 `scope=quota` 用独立上限 `QUOTA_MAX_BACKOFF_MS = 4h`（其它 scope 仍 24h）。
- 效果：quota 冻结账号盲探间隔封顶 4h（15min→30min→1h→2h→**4h 封顶**），非 24h。

### E-2 零请求计费触发器（主路径，始终开，无需授权、无成本）
- 每次 pool 操作（任意 `run`、`pool status`、调度器 tick）时，对每个 `scope=quota` 的 frozen/probe-not-due 账号，读它自己的 `grokHome/logs`（复用已硬化的 `readBillingSignal`，只读、拒 symlink、白名单重建）。
- 命中"额度恢复"证据即把 `nextProbeAt→now`、`state→probe_due`：
  - `creditUsagePercent` 明显掉回 100 以下（阈值可配，默认 <95）；或
  - 出现晚于冻结 `observedAt` 的新 `billingPeriodStart`。
- **零真实请求**，故可无条件自动执行；计费非权威 → 只是让账号提前进入 probe_due，仍须真实探针成功才转 active。
- `pool status` 是零请求命令，也可安全执行此转换（只改本地状态、不发请求）。

### E-3 自动真实探针（满足"不用人工喊"）
- 新增 **pool 级** 配置（存 registry 或独立 pool-config，**非** task capsule；开一次即长期生效）：
  ```json
  { "autoProbe": { "enabled": true, "scope": "quota",
                   "quotaMaxBackoffMs": 14400000,
                   "globalMaxProbesPerHour": 6,
                   "realRequestPermission": "allowed" } }
  ```
- `enabled:true` 时，`probe_due` 的 quota 账号在 pool 操作中被**自动探针**，且**不受 `when-no-active` 限制**（池里有 active 也照样救冻结成员——这正是目的）。
- 仍有界：`globalMaxProbesPerHour` 全局频率上限、每 profile 单飞、E-1 的 4h 盲探间隔、每探针单回合最小请求（`grok-4.5/high --no-plan --no-memory --max-turns 1`）。
- 这一 pool 级 opt-in **本身就是授权**：Owner 开一次，之后全自动；默认 `enabled:false` 保持 v5 保守行为。
- 与 v5 的 per-task `probePolicy` 并存：per-task 仍管单次任务内的自救；`autoProbe` 是独立于任务的常驻维护探针。

### E-4 空闲兜底调度器（真正"自动"，不依赖总控是否在跑）
- 注册 Windows 计划任务：每 ~30–60min 跑 `grok-worker pool refresh --auto`。
- `--auto` = 先跑 E-2 零请求计费扫描；再对到期 `probe_due` 账号按 E-3 规则和全局频率上限发探针。
- 保证总控空闲时早重置也能被自动捕捉。

## 3. 恢复判定（不变）
- 真实探针成功 → `active`、`consecutiveFailures=0`、`nextProbeAt=null`。
- 仍 402 → 重新 `frozen`、`consecutiveFailures+1`、按 E-1（4h 封顶）重算 `nextProbeAt`。
- `grok models` 仍只验 OAuth，永不授 active。

## 4. 浪费上界（回答"会不会自动烧额度"）
- 主命中走 E-2 零请求 → 大多数早重置不花探针即被发现。
- 盲探仅在计费无信号时按 4h 间隔 + `globalMaxProbesPerHour` 触发；单账号最坏每 4h 一次单回合最小请求。
- 每次探针成本可从 usage ledger 审计（`total_cost_usd_ticks`）。

## 5. 测试（默认零真请求原则不变）
- fixture：计费恢复信号→probe_due 转换、4h 退避封顶、autoProbe 关时不自动探、autoProbe 开时不受 when-no-active 阻挡、globalMaxProbesPerHour 限流、盲探仍走 maxProbes/单飞。
- opt-in live canary 才发真实探针；默认 harness 100% mock。

## 6. 待 Owner 确认的取舍
- `globalMaxProbesPerHour` 默认值（草案 6/h，即最坏每账号约每 10min 有机会但受 4h 盲探间隔约束实际远低于此）。
- `creditUsagePercent` 恢复阈值（草案 <95）。
- 计划任务频率（草案 30–60min）。
