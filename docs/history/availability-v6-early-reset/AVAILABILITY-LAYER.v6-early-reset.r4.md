# v6-r4：自动早重置恢复（自包含施工合同，含完整 schema/XML/命令）

> 基于已施工的 v5。取代 v6 草案/r2/r3（均终审 FAIL）。施工只读本文件。
> Owner 约束：quota 退避硬上限 4h；自动、不靠人工。安全线：计费只作机会性提示、只有真实探针成功才授 active。
> 定稿日期：2026-07-21

## 0. 三个架构决定（解多条审计）
- **A. Sidecar，不升 availability schema**（解 r3#3/#4）：核心 `availability.provider.v5.json` **完全不动**（schemaVersion 保持 5）。维护字段全部放独立 `maintenance-profile.v6.json`（按 profileId）。v5 代码不读 sidecar → **v6→v5 回滚自动安全，无需降级迁移**（availability.js:90 遇非 5 会重置为 unknown，故绝不升级 availability 本身）。
- **B. 复用 v5 的 `classifyError`+`shouldTouchAvailability` 与 `planTemplate`/`verifyPlanContract`**（解 r3#5/#6）：探针的非 402 结果（401/账号级429/model_unavailable/network/provider/unknown）走 v5 既有归因,不另造；探针命令走 v5 计划合同校验,不只信 Capsule 字段。
- **C. 维护 profile lock 用与 workload 完全相同的 `profile.grokHome` key**（解 r3#7）：探针与真实任务互斥同一 profile。

## 1. 定稿参数
quota 退避硬上限 4h（jitter 只向下，末尾 `min(4h)`）；scheduler 30min；全局 4 probes/hour；`maxProbesPerTick=2`；每 profile 盲探最小间隔 4h；单探针 timeout ≤120s；两探针+清理 <10min；计费 `recovered_lt_95`（`creditUsagePercent<95`）或新 `billingPeriodStart` 晚于冻结 → 至多提前一次,永不授 active；reauth_required/manual_hold 永不自动探针。

## 2. 命令面 + 启动重构（r3#1 沿用）
`main()` **先 parseArgs**；只读命令（`version`/`doctor`/`pool status`/`profiles list`）走纯只读快路径（幂等 ensureDir，不 cleanupOrphanRaw、不 recoverInterruptedRuns、不 ensureDefaultProfile、不写 availability/sidecar）。合同：`pool status` = 零真请求 + 零状态变更 + 零 raw/WAL 写。唯一扫描+探针入口 = `pool maintenance tick`。

## 3. 完整 Schema（施工须精确创建以下文件）

### 3.1 `schemas/maintenance-profile.v6.schema.json`（sidecar，按 profileId）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://grok-ui.local/schemas/maintenance-profile.v6.schema.json",
  "type":"object","additionalProperties":false,
  "required":["schemaVersion","profileId","revision","updatedAt","episodeId",
    "earlyBillingProbeConsumed","consumedBillingSignalId","lastBillingObservedAt",
    "lastMaintenanceProbeAt","minProbeIntervalMs"],
  "properties":{
    "schemaVersion":{"const":6},
    "profileId":{"type":"string","format":"uuid"},
    "revision":{"type":"integer","minimum":0},
    "updatedAt":{"type":"string"},
    "episodeId":{"type":["string","null"]},
    "earlyBillingProbeConsumed":{"type":"boolean"},
    "consumedBillingSignalId":{"type":["string","null"]},
    "lastBillingObservedAt":{"type":["string","null"]},
    "lastMaintenanceProbeAt":{"type":["string","null"]},
    "minProbeIntervalMs":{"type":"integer","minimum":0}
  } }
```

### 3.2 `schemas/pool-config.v6.schema.json`（`{DATA_ROOT}/pool-config.v6.json`，不进 registry/不进不可变 release）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://grok-ui.local/schemas/pool-config.v6.schema.json",
  "type":"object","additionalProperties":false,
  "required":["schemaVersion","revision","updatedAt","autoProbe","authorization"],
  "properties":{
    "schemaVersion":{"const":6},"revision":{"type":"integer","minimum":0},"updatedAt":{"type":"string"},
    "autoProbe":{"type":"object","additionalProperties":false,
      "required":["enabled","scope","quotaMaxBackoffMs","globalMaxProbesPerHour","maxProbesPerTick","minProbeIntervalMs"],
      "properties":{"enabled":{"type":"boolean"},"scope":{"const":"quota"},
        "quotaMaxBackoffMs":{"const":14400000},"globalMaxProbesPerHour":{"type":"integer","minimum":0},
        "maxProbesPerTick":{"type":"integer","minimum":0},"minProbeIntervalMs":{"type":"integer","minimum":0}}},
    "authorization":{"type":"object","additionalProperties":false,
      "required":["realRequestPermission","authorizationScope","authorizedProfileIds","authorizedAt","revokedAt"],
      "properties":{"realRequestPermission":{"enum":["allowed","denied"]},
        "authorizationScope":{"const":"quota-maintenance-probe"},
        "authorizedProfileIds":{"type":"array","items":{"type":"string","format":"uuid"},"uniqueItems":true},
        "authorizedAt":{"type":["string","null"]},"revokedAt":{"type":["string","null"]}}}
  } }
```
默认 `autoProbe.enabled=false` 且 `authorization.realRequestPermission=denied`。

### 3.3 `schemas/maintenance-task.v6.schema.json`
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["maintenanceTaskId","profileId","kind","prompt","expectedResponseContains","maxTurns","timeoutMs"],
  "properties":{"maintenanceTaskId":{"type":"string"},"profileId":{"type":"string","format":"uuid"},
    "kind":{"const":"quota-availability-probe"},"prompt":{"type":"string","minLength":1},
    "expectedResponseContains":{"type":"string","minLength":1},
    "maxTurns":{"const":1},"timeoutMs":{"type":"integer","maximum":120000}} }
```
确定性 prompt（示例）：`"Reply with exactly: grok-availability-ok"`；`expectedResponseContains:"grok-availability-ok"`。

### 3.4 `schemas/maintenance-result.v6.schema.json`
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["maintenanceInvocationId","profileId","outcome","errorClassification","end","requestId",
    "exitCode","expectedResponseMatched","usage","rawCleanup","walFinalState"],
  "properties":{"maintenanceInvocationId":{"type":"string","format":"uuid"},"profileId":{"type":"string","format":"uuid"},
    "outcome":{"enum":["recovered","still-exhausted","reauth","cooldown","no-op","inconclusive"]},
    "errorClassification":{"type":["object","null"]},
    "end":{"type":"boolean"},"requestId":{"type":["string","null"]},"exitCode":{"type":["integer","null"]},
    "expectedResponseMatched":{"type":"boolean"},
    "usage":{"type":"object"},"rawCleanup":{"enum":["deleted","failed"]},
    "walFinalState":{"enum":["completed","failed","interrupted"]}} }
```

### 3.5 `schemas/rate-bucket.v6.schema.json`（`{DATA_ROOT}/maintenance/rate-bucket.json`）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["schemaVersion","capacity","tokens","windowMs","lastRefillAt","revision"],
  "properties":{"schemaVersion":{"const":6},"capacity":{"const":4},"tokens":{"type":"number","minimum":0},
    "windowMs":{"const":3600000},"lastRefillAt":{"type":"string"},"revision":{"type":"integer","minimum":0}} }
```

## 4. episodeId 生命周期（r3#2）
`episodeId` 必需但可空：`active/unknown/reauth_required/manual_hold → null`；`frozen/cooldown/probe_due + scope=quota → 非空`。**进入新 quota frozen episode** 时生成新 id；同一 episode 内 402 重冻结**保持不变**。存于 sidecar。

## 5. 计费信号身份 + episode 级消费（r3#3）
- 身份 `billingSignalId = sha256(profileId + "|" + episodeId + "|" + billingPeriodStart + "|" + percentState)`，`percentState` 固定语义值 `recovered_lt_95`（非模糊 rounded）。
- **每冻结 episode 仅一个 `earlyBillingProbeConsumed`**（bool）；证据存 `consumedBillingSignalId`。
- **`lastBillingObservedAt` = 单调水位**：记录 `ts <= watermark` 一律拒绝；命中恢复且 `ts > watermark` 且 `earlyBillingProbeConsumed=false` 才提前一次。
- 事务：先写 probe WAL/租约 + 扣 token → 再置 `earlyBillingProbeConsumed=true`、更新 watermark。预算不足/崩溃 → 待处理信号不丢（下次 tick 因 consumed=false 重评估）。
- 定性：机会性提示；**主发现机制是 §1 的 4h 盲探周期**。

## 6. 维护探针执行合同（r3#4/#5/#6，复用 v5 决定 B）
`pool maintenance tick` 对每个入选账号：
1. 授权硬门（§3.2）：config 合法 + `autoProbe.enabled` + `realRequestPermission=allowed` + `revokedAt=null` + profileId ∈ `authorizedProfileIds`。不满足 → 零请求硬失败（记 inconclusive）。
2. 取 scheduler lock → 排序选账号 → **profile 忙则不扣 token**（§7）。
3. 写 maintenance WAL(planned)；**扣 rate-bucket token(CAS)**；WAL→running。
4. 取 profile lock（key=`profile.grokHome`，与 workload 同）。
5. 构 scratch cwd（临时目录，**无项目文件权限**），隔离 GROK_HOME + G-0 hooks env；**新 session-id、无 resume**。
6. **CLI argv（固定，过等价 `verifyPlanContract`，不只信 Capsule）**：
   ```
   grok --no-plan --no-memory --output-format streaming-json
        --prompt-file <SCRATCH>\probe.prompt.txt --cwd <SCRATCH>
        --model grok-4.5 --reasoning-effort high
        --disallowed-tools run_terminal_cmd,Agent --no-subagents --disable-web-search
        --session-id <NEW_UUID> --leader-socket <SCRATCH>\leader.sock
        --allow  (空)   --deny Bash --deny MCPTool(*) --deny WebFetch(*) --deny WebSearch
   ```
   isolated settings：`defaultMode=dontAsk`、allow 空、永久 deny(.git/.grok/.claude/runtime/Bash/MCP/Web)；env `GROK_FOLDER_TRUST` 未设、`GROK_CLAUDE_HOOKS_ENABLED=false`、`GROK_CURSOR_HOOKS_ENABLED=false`；timeout≤120s。
7. 仍持 profile lock 时：`redactText(stderr)` → **复用 v5 `classifyError`** → 确定性转移：
   - 成功（真实 `end` + 有效 requestId + exitCode 0 + `expectedResponseMatched` 全满足）→ availability `active`（v5 CAS 写）。
   - `quota_exhausted` → 重冻结（同 episodeId）+ §1 重算 nextProbeAt。
   - `reauth_required`(401) → availability `reauth_required`（否则 scheduler 会一直请求）。
   - 账号级 `rate_limited`(429+证据) → `cooldown`。
   - `model_unavailable` → **不冻结**（记 no-op）。
   - `network/provider/unknown` → 只写 global health，**不改 profile 长期状态**。
   - timeout/cancel/crash → inconclusive，不改冻结，**不退 token**，WAL→interrupted。
8. **写 usage ledger**（§8）；释放 profile lock → scheduler lock；WAL→completed/failed/interrupted。

## 7. 锁 / WAL / token 次序（r3#7）
- **扩 `acquireLock`**：新增 `scheduler`（全局单例，patterns=固定常量）、`rate-bucket` 真实冲突规则（现只认 profile/workspace，未知 scope 不冲突）。
- **统一锁顺序**：scheduler → rate-bucket → profile(grokHome) → availability/sidecar。所有 availability 写入口遵同序。
- profile 正忙（workload 持 grokHome lock）→ **不扣 token、跳过该账号**。
- token 在"即将 spawn、请求可能发生"边界扣；**保留但未确认的 token 不退款**（崩溃不重复请求）。
- WAL 先 planned，扣 token 后立即 running；signal 仅在请求跨过 spawn 边界才标 consumed。
- 长探针期间 scheduler/profile lock 持续 heartbeat；stale lock 用 v5 TTL+pid/starttime 恢复。
- 时钟回拨：refill `now<lastRefillAt` 不补充、不透支；bucket/config 损坏 → fail-closed 零请求。

## 8. 用量归属 + 时限预算（r3#8）
- 探针真实消耗额度 → **必须写 Provider usage ledger**，key `profileId + maintenanceTaskId + maintenanceInvocationId`；缺 usage（如 402 无 usage）记 `unknown`，不记 0。
- 单探针 timeout ≤120s；`maxProbesPerTick=2` → 两探针 + 清理必须 <10min（计划任务 `ExecutionTimeLimit=PT10M`）。超时终止落 interrupted WAL。

## 9. Windows 计划任务（r3#7，完整）
### 9.1 XML `deploy/GrokWorkerProviderMaintenance.xml`
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Grok Worker Provider quota early-reset maintenance</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger><StartBoundary>2026-07-21T00:00:00</StartBoundary>
      <Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT5M</Interval><Count>1</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>%USERPROFILE%\.local\bin\grok-worker.cmd</Command>
      <Arguments>pool maintenance tick</Arguments>
      <WorkingDirectory>%USERPROFILE%\AppData\Local\GrokWorkerProvider</WorkingDirectory></Exec>
  </Actions>
</Task>
```
### 9.2 命令
```bat
:: install
schtasks /Create /TN "GrokWorkerProviderMaintenance" /XML "deploy\GrokWorkerProviderMaintenance.xml" /F
:: disable / enable
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
schtasks /Change /TN "GrokWorkerProviderMaintenance" /ENABLE
:: uninstall
schtasks /Delete /TN "GrokWorkerProviderMaintenance" /F
```
### 9.3 诚实限制
`InteractiveToken` + 不存密码 ⇒ **仅在该用户已登录时运行**，**不能宣称登出后全自动**。施工机长期登录时可接受；登出全自动须服务账号/存凭据 → 安全线禁止，**本增补不做**。

## 10. 回滚（sidecar 使之安全）+ 流程门禁纠正
- **回滚安全**：availability 保持 v5、维护字段在 sidecar，v5 代码不读 sidecar → 直接回滚不丢四账号状态。
- **升级/回滚顺序**：先停/禁用计划任务 → 再切 release pointer（防 v5 收到不认识的 `maintenance tick`）。
- **流程顺序（纠正 r3 循环门禁）**：
  1. **r4 施工合同独立终审 PASS**（当前阶段）；
  2. 再实现 schema/代码/fixture/调度安装资产；
  3. 默认 mock 独立实现审计；
  4. 单独授权 live canary；
  5. 单独授权 standing authorization + 安装计划任务。

## 11. 验收矩阵
| 项 | 验收 |
|---|---|
| 4h 硬上限 | 1e4 采样 max ≤ 4h |
| pool status 零写 | 不触发 cleanup/WAL/availability/sidecar 写 |
| sidecar 回滚安全 | v5 代码读不到 sidecar；回滚后四账号状态保留 |
| episodeId 语义 | 非 quota-frozen 态为 null；同 episode 402 重冻结不变 |
| 计费去重 | 每 episode 至多提前一次；watermark 拒 ts≤水位；内容哈希去重 |
| 授权机器校验 | config 缺失/非法/撤销/profile 不在集合 → 零请求硬失败 |
| 探针非 402 分支 | 401→reauth、账号429→cooldown、model_unavailable→不冻结、network/provider/unknown→仅 global health |
| 探针命令合同 | 过等价 verifyPlanContract；dontAsk/空allow/永久deny/GROK_FOLDER_TRUST 未设 |
| 锁次序 | scheduler→rate-bucket→profile(grokHome)→availability；profile 忙不扣 token |
| token 语义 | 跨进程持久；保留不退款；时钟回拨不透支；损坏 fail-closed |
| 用量归属 | 探针 usage 入 ledger；缺 usage=unknown |
| 时限预算 | 单探针≤120s；2 探针+清理<10min；超时落 interrupted |
| 计划任务 | IgnoreNew+单实例锁；无密码；登出限制已标注；install/disable/delete/rollback 命令齐 |
| 默认 harness | 100% mock，零真请求 |
```
```
