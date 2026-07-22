# v6-r2 增补：自动早重置恢复（修订版，吸收第五轮审计 10 项）

> 取代 v6 草案（FAIL）。基于已施工的 v5。只加"自动早重置恢复"，不改 v5 核心。
> Owner 约束：quota 退避硬上限 4h；必须自动、不靠人工。
> 定稿日期：2026-07-21

## 0. 审计纠正的事实（v6 草案错，已核准代码）
- 计费读函数真名 `readBillingSnapshot`（availability.js:734），非 `readBillingSignal`；白名单现为 `billingPeriodEnd/periodEnd/resetAt/usedPercent/quotaUsedPercent/status`，**缺** `creditUsagePercent`/`billingPeriodStart`（而真实日志字段叫 `creditUsagePercent`，嵌在 `ctx.config`）。
- usage ledger **不存** `total_cost_usd_ticks`，`numericUsage` 只取 token → **删除"可从 ledger 审计成本"的说法**（如需成本审计另列扩展项）。
- `profiles probe`(provider.js:330) 只跑 `grok models`；pool refresh `realRequests:0` → **当前没有真实 availability 探针实现**，E-3 须新建。
- **冻结账号不发请求 → 其本地计费日志未必出现新记录** → 计费信号只能是"机会性加速器"，**不能**声称能自动发现大多数早重置。真正的发现机制是 E-3 的盲探周期。

## 1. 定稿参数（Owner + 审计定案）
- quota 退避**硬上限 4h**：截断后叠加的 jitter **只能向下**（或叠后再 `min(4h)`），最终值含 jitter 不得 > 4h。
- scheduler：**30 分钟**。
- 每 profile：普通盲探最小间隔 **4h**；仅"严格更新且未消费"的计费信号可提前**一次**。
- 全局：**4 probes/hour**，`maxProbesPerTick=2`（跨进程持久化）。
- `<95%` 计费信号：须满足"记录时间晚于冻结时间 + 信号键未消费"，**只触发探针，永不直接授 active**。
- `reauth_required`、`manual_hold`：**永不自动探针**。

## 2. 改动项（对应审计 1–10）

### R-1（审计#1）4h 真硬上限
`computeNextProbeAt` 对 `scope=quota`：`min(4h, base·2^n)` 后 jitter **向下偏移**，末尾再 `min(4h)`。单元测试断言 10^4 次采样最大值 ≤ 4h。

### R-2（审计#2/#9）防旧计费信号反复触发 + 存量迁移
availability 记录新增并持久化：`lastConsumedBillingSignalId`、`lastMaintenanceProbeAt`、`lastBillingObservedAt`、`minProbeIntervalMs`（默认 4h）。
- 计费加速仅当 `billingSignalId` **严格新于** `lastConsumedBillingSignalId` **且** 记录 `ts` 晚于冻结 `observedAt`；消费后写 `lastConsumedBillingSignalId`，同一信号不可再用。
- 普通盲探须 `now - lastMaintenanceProbeAt >= minProbeIntervalMs`，探针 402 重冻结不绕过此间隔。
- **一次性 CAS 迁移**：仅对 `scope=quota` 且 `nextProbeAt > now+4h` 的存量记录夹到 4h；**不碰** cooldown/reauth/manual_hold。

### R-3（审计#3）计费触发降级为"机会性提示"
- 用真实接口 `readBillingSnapshot`；白名单**补** `creditUsagePercent`、`billingPeriodStart`，并适配 `ctx.config` 嵌套。
- 命中"恢复"（`creditUsagePercent < 95` 或新 `billingPeriodStart` 晚于冻结）→ 提前一次 probe_due（受 R-2 去重约束）。
- 文档与代码注释均标注：**机会性、非主路径**；主发现机制是 R-5 的 4h 盲探周期。计费永不授 active。

### R-4（审计#4）唯一维护入口，命令面隔离
- `pool status`：**严格只读、零请求、零写**（不得隐式改状态）。
- 普通 `run`：**不**附带隐藏维护请求。
- **新增 `pool maintenance tick`：唯一允许扫描 + 自动探针的入口**。
- Windows 计划任务只调 `pool maintenance tick`。

### R-5（审计#5）真实 availability 探针的完整执行合同
新建独立真探针（**不是** `grok models`），复用 v5 的隔离骨架：
- 独立 maintenance Task/Result Capsule + WAL（planned→running→completed/failed/interrupted）+ usage invocation。
- profile lock + 全局 scheduler lock；scratch cwd（**无项目文件权限**）；不复用任何 session。
- 命令：`grok-4.5/high --no-plan --no-memory --max-turns 1`，含超时 + 原始流内存解析后清理（沿用 v5 redaction）。
- 成功 → active（consecutiveFailures=0，nextProbeAt=null）；仍 402 → 重冻结 + R-1 重算 + 更新 lastMaintenanceProbeAt。

### R-6（审计#6）全局限流跨进程持久化
- `{DATA_ROOT}/maintenance/rate-bucket.json` 持久化 token bucket（4 probes/hour），全局锁下原子 CAS 更新（计划任务每次是新进程，内存计数无效）。
- `maxProbesPerTick=2`：单次 tick 最多探 2 个，防一次扫全池。

### R-7（审计#7）pool 配置独立文件
- 新增 `{DATA_ROOT}/pool-config.v6.json` + `pool-config.v6.schema.json`：`schemaVersion`、`revision`(CAS)、`autoProbe{enabled,scope,quotaMaxBackoffMs,globalMaxProbesPerHour,maxProbesPerTick,minProbeIntervalMs}`、启用/关闭命令、`authorizedAt`、适用 profile/scope、审计记录。
- **不进 registry**（其 additionalProperties:false 会破）、**不进不可变 release 目录**。默认 `enabled:false`（保持 v5 保守）；Owner 开一次即长期自动。

### R-8（审计#8）删除成本审计声明
- 不再声称可从 ledger 审计成本。若需要：另列可选扩展——`numericUsage` + usage-ledger schema 增 `total_cost_usd_ticks` 解析，属独立任务，不进本增补验收。

### R-9（审计#10）Windows 计划任务完整合同
定死：任务名 `GrokWorkerProviderMaintenance`；**当前用户上下文、不存密码**；绝对 shim 路径；隐藏窗口；**无提权**；禁止并发实例（`/IT` off + 单实例锁）；超时；失败重试策略；睡眠/错过触发 = 下次正常触发不补跑堆积；状态日志；disable/uninstall/rollback 行为定义。

## 3. 测试与门（默认零真请求不变）
- fixture：4h 硬上限采样、旧计费信号不重复触发、存量迁移只夹 quota、`pool status` 零写零请求、maintenance tick 是唯一探针入口、跨进程 token bucket 限流、maxProbesPerTick=2、真探针完整隔离合同、reauth/manual_hold 不被探。
- opt-in live canary 才发真实探针；默认 harness 100% mock、零真请求。
- 部署/回滚门：pool-config 与计划任务的 enable/disable/uninstall 可回滚。

## 4. 独立审计要求
补齐以上合同 + fixture + 部署/回滚门后，再走一次独立审计，PASS 才施工。
