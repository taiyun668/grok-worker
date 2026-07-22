# v6-r3：自动早重置恢复（自包含施工合同）

> 基于已施工的 v5。取代 v6 草案 / r2（均终审 FAIL）。**本文件自包含**：含参数、命令面、schema 字段规格、状态事务、计划任务定义、迁移与验收矩阵。施工只读本文件。
> Owner 约束：quota 退避硬上限 4h；自动、不靠人工。安全线：计费只作机会性提示、只有真实探针成功才授 active。
> 定稿日期：2026-07-21

## 0. 范围
只加"quota 冻结账号的自动早重置恢复"。不改 v5 的状态机 7 态、锁生命周期、归因边界、per-task probePolicy。不动四个现有认证 profile。

## 1. 定稿参数
- quota 退避硬上限 **4h**，jitter **只向下**，末尾再 `min(4h)`。
- scheduler **30min**；全局 **4 probes/hour**；`maxProbesPerTick=2`；每 profile 盲探最小间隔 **4h**。
- 计费 `creditUsagePercent < 95` 或新 `billingPeriodStart` 晚于冻结 → 至多提前**一次**探针；**永不授 active**。
- `reauth_required`、`manual_hold` 永不自动探针。

## 2. 命令面 + 启动重构（审计#1）
现 `main()` 在 parseArgs 前就 ensureDir/cleanupOrphanRaw/recoverInterruptedRuns/ensureDefaultProfile（provider.js:1609），故 `pool status` 无法零写。**r3 重构**：
- `main()` **先 parseArgs**，再按命令分流。
- **只读快路径**（`version`/`doctor`/`pool status`/`profiles list`）：只 `ensureDir`（幂等、无内容写）后走纯只读，**不** cleanupOrphanRaw、**不** recoverInterruptedRuns、**不** ensureDefaultProfile、**不**改 availability。合同表述：`pool status` = 零真实请求 + 零 availability 变更 + 零 raw/WAL 变更。
- 变更类命令（`run`/`pool maintenance tick`/`pool bootstrap`/`pool config`）才跑完整启动维护。
- **`pool maintenance tick` 是唯一允许扫描+自动探针的入口**；`run` 不附带隐藏维护请求。

## 3. Schema（新增/升级）

### 3.1 availability v5→v6（审计#3）
- 新建 `availability.provider.v6.schema.json`，`schemaVersion const 6`，`additionalProperties:false`，在 v5 required 上**增**：
  - `lastConsumedBillingSignalId`: string|null
  - `lastMaintenanceProbeAt`: ISO|null
  - `lastBillingObservedAt`: ISO|null
  - `minProbeIntervalMs`: int（默认 14400000）
  - `episodeId`: string（每次进入 frozen 生成，用于"同一冻结 episode 只提前一次"）
- 迁移：幂等、CAS；损坏记录 **fail-closed**（视为 excluded，不臆造 active）；同步 `current.json.schemaVersions.availability=6`、doctor、checker、回滚兼容（v6 记录被 v5 读到时 v5 应安全忽略新字段或拒绝——回滚顺序见 §8）。

### 3.2 maintenance-task / maintenance-result（审计#4）
现 Task Capsule 强制 git/workspace/worktree/allowedFiles，不适用无项目 scratch probe → **独立 schema** `maintenance-task.v6.schema.json` / `maintenance-result.v6.schema.json`：
- task：`maintenanceTaskId`、`profileId`、`kind:"quota-availability-probe"`、`standingAuthRef`(指向 §3.4 授权)、`prompt`(确定性最小)、`expectedResponseContains`、`allTools:"denied"`、`write:"denied"`、`sessionResume:"denied"`、`maxTurns:1`、`timeoutMs`。
- result：`maintenanceInvocationId`、`profileId`、`outcome:"recovered|still-exhausted|inconclusive"`、`end`(bool)、`requestId`、`exitCode`、`expectedResponseMatched`(bool)、`usage`(**402 无 usage 记 `unknown` 非 0**)、`rawCleanup`、`walFinalState`。
- **成功判据(全满足)**：真实 `end` 事件 + 有效 requestId + 退出码 0 + `expectedResponseMatched`。任一不满足 → 不授 active。

### 3.3 pool-config v6 + 授权对象（审计#5、#7）
`{DATA_ROOT}/pool-config.v6.json`（**不进 registry、不进不可变 release**）+ `pool-config.v6.schema.json`，`revision`(CAS)：
```json
{ "schemaVersion": 6, "revision": 1, "updatedAt": "...",
  "autoProbe": { "enabled": false, "scope": "quota",
    "quotaMaxBackoffMs": 14400000, "globalMaxProbesPerHour": 4,
    "maxProbesPerTick": 2, "minProbeIntervalMs": 14400000 },
  "authorization": { "realRequestPermission": "denied",
    "authorizationScope": "quota-maintenance-probe",
    "authorizedProfileIds": [], "authorizedAt": null, "revokedAt": null } }
```
- **maintenance tick 发真实请求前必须机器校验**：config 存在且合法、`autoProbe.enabled=true`、`authorization.realRequestPermission=allowed`、`revokedAt=null`、目标 profileId ∈ `authorizedProfileIds`。任一不满足 → **零请求硬失败**（记 inconclusive，不探）。

### 3.4 rate-bucket（审计#6）
`{DATA_ROOT}/maintenance/rate-bucket.json` + schema：`capacity=4`、`tokens`、`lastRefillAt`、`windowMs=3600000`、`revision`。跨进程持久，全局锁下 CAS 更新。

## 4. 计费信号身份与消费事务（审计#2）
- **身份 = 规范化内容哈希** `billingSignalId = sha256(profileId + billingPeriodStart + roundedPercentState)`；**不以日志 ts 作身份**。
- **新旧比较用已验证时间戳**（记录 `ts` 必须晚于冻结 `observedAt` 且解析有效），**ID 只做相等去重**。
- **同一 (episodeId, billingPeriodStart, percentState) 至多提前一次**：命中且 `billingSignalId != lastConsumedBillingSignalId` 才提前。
- **事务顺序**：先持久化 probe 的 WAL/租约 + 扣 rate-bucket token → 再写 `lastConsumedBillingSignalId=该ID`。预算不足或进程崩溃时待处理信号不丢（下次 tick 重评估，因 ID 未标 consumed）。
- 定性：计费是**机会性提示**（冻结账号不发请求，其本地日志未必有新记录），**主发现机制是 §5 的 4h 盲探周期**。

## 5. 维护探针执行合同（审计#4）
`pool maintenance tick` 内，对每个入选账号：
1. 取全局 scheduler lock → 选账号(§6 排序) → 扣 rate-bucket token（CAS）。
2. 写 maintenance WAL(planned→running)；取 profile lock。
3. scratch cwd（临时目录，**无项目文件权限**），隔离 GROK_HOME（沿用 v5 isolatedEnv + G-0 hooks 关闭 env），**无 session 复用**。
4. `grok-4.5 --reasoning-effort high --no-plan --no-memory --max-turns 1`（确定性最小 prompt），含 timeout；原始流内存解析后清理（v5 redaction）。
5. 仍持 profile lock 时判定 + 写 availability v6（CAS）：成功→active(consecutiveFailures=0,nextProbeAt=null)；仍 402→重冻结(同 episodeId)+§1 重算 nextProbeAt+更新 lastMaintenanceProbeAt；timeout/cancel/crash→inconclusive，不改冻结状态、不退 token。
6. 释放 profile lock → scheduler lock；WAL→completed/failed/interrupted。

## 6. 限流与并发协议（审计#6）
- **统一锁顺序**：scheduler → rate-bucket → profile → availability（防死锁）。
- **公平排序**：`nextProbeAt → lastMaintenanceProbeAt → profileId`（防饥饿）。
- **token 语义**：取走即扣；**保留但未确认的 token 不退款**（崩溃后不重复请求，宁可少探一次）。
- **时钟回拨**：refill 用单调判断，`now < lastRefillAt` 时不补充、不透支。
- **fail-closed**：rate-bucket 或 config 损坏 → 零请求。
- **stale lock**：TTL + pid/starttime 校验（沿用 v5 acquireLock 机制）恢复。

## 7. 存量迁移（审计#3、#9）
一次性 CAS 迁移：仅 `scope=quota` 且 `nextProbeAt > now+4h` 的存量记录夹到 ≤4h；补 §3.1 新字段默认值 + `episodeId`；**不碰** cooldown/reauth/manual_hold；损坏 fail-closed。

## 8. Windows 计划任务合同（审计#7）
- **并发**：Task Scheduler `MultipleInstancesPolicy=IgnoreNew`（**不是** `/IT off`——那表达的是别的）+ Provider 单实例锁（scheduler lock）。
- **principal**：当前用户 `LogonType=InteractiveToken`、`RunLevel=LeastPrivilege`（无提权、**不存密码**）。
- **诚实限制**：无密码 ⇒ **通常仅在该用户已登录时运行**，**不能宣称登出后全自动**。施工机长期登录时可接受；需登出后自动须服务账号/存凭据——本增补**不做**（安全线禁止），故明确标注此限制。
- **动作**：`Execute=%USERPROFILE%\.local\bin\grok-worker.cmd`，`Arguments=pool maintenance tick`，`WorkingDirectory=%LOCALAPPDATA%\GrokWorkerProvider`。
- **触发**：每 30min；`StartWhenAvailable=false`（错过不补跑堆积，下次正常触发）。
- **限制**：`ExecutionTimeLimit=PT10M`；失败重试 `RestartCount=1 RestartInterval=PT5M`。
- **管理命令**：install/disable/uninstall 用 `schtasks`（任务名 `GrokWorkerProviderMaintenance`）；提供 rollback。
- **升级/回滚顺序**：**先停/禁用计划任务 → 再切 release pointer**（防 v5 收到不认识的 `maintenance tick`）。

## 9. 验收矩阵（默认零真请求）
| 项 | 验收 |
|---|---|
| 4h 硬上限 | 1e4 次采样 max ≤ 4h |
| pool status 零写 | status 路径不触发 cleanup/WAL/availability 写 |
| 旧计费信号不重触发 | 同 (episode,period,percent) 只提前一次；ID 内容哈希去重 |
| 授权机器校验 | config 缺失/非法/撤销/profile 不在集合 → 零请求硬失败 |
| token bucket 跨进程 | 新进程读持久 bucket；崩溃不退款；时钟回拨不透支 |
| maxProbesPerTick=2 | 单 tick 最多探 2 |
| 真探针隔离 | 无项目权限/无 session/max-turns 1；402 usage=unknown |
| 存量迁移 | 只夹 quota；不碰 cooldown/reauth/manual_hold |
| 计划任务并发 | IgnoreNew + 单实例锁；无密码；登出限制已标注 |
| 回滚顺序 | 先停任务再切 pointer |
| 默认 harness | 100% mock，零真实请求 |

## 10. 门
补齐 §3 schema 文件 + §4/§5/§6 状态事务 + §8 计划任务 XML/命令 + §9 验收矩阵实现后，再走一次施工前独立终审，PASS 才施工。live canary / 计划任务安装 / 动认证 profile 均须单独显式授权。
