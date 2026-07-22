# v6-r6：自动早重置恢复（唯一事实源，单文件自包含）

> **本文件是唯一事实源。r2/r3/r4/r5 仅历史证据，施工不得引用。** 基于已施工 v5，只加 quota 冻结账号的自动早重置恢复，不改 v5 状态机7态/锁生命周期/归因边界，不动四个认证 profile。
> Owner 约束：quota 退避硬上限 4h；自动、不靠人工。安全线：计费只作机会性提示；只有真实探针成功才授 active。
> 定稿日期：2026-07-21

## 1. 固定参数与默认值
| 参数 | 值 |
|---|---|
| quota 退避硬上限（含 jitter，含 resetAt 分支） | **≤ 4h** |
| jitter | 只向下 |
| scheduler 周期 | 30min |
| 全局探针频率 | 4 probes/hour |
| maxProbesPerTick | 2 |
| 每 profile 盲探最小间隔 minProbeIntervalMs | 14400000 (4h) |
| 单探针 timeout | ≤120s |
| 两探针+清理总预算 | <10min（任务 ExecutionTimeLimit PT10M） |
| 计费恢复信号 | `creditUsagePercent<95` 或新 billingPeriodStart 晚于冻结，`percentState=recovered_lt_95` |
| 计费提前 | 每冻结 episode 至多一次，永不授 active |
| autoProbe.enabled 默认 | false |
| authorization.realRequestPermission 默认 | denied |
| reauth_required/manual_hold | 永不自动探针 |
| PROBE_PROMPT | `"Reply with exactly: grok-availability-ok"`（Provider 内部常量） |
| PROBE_EXPECT | `"grok-availability-ok"` |

## 2. 命令面 + 启动
`main()` 先 parseArgs。只读命令（version/doctor/pool status/profiles list）走纯只读快路径：幂等 ensureDir，不 cleanupOrphanRaw/recoverInterruptedRuns/ensureDefaultProfile、不写 availability/sidecar。`pool status`=零真请求+零状态变更+零 raw/WAL 写。唯一扫描+探针入口=`pool maintenance tick`（变更类，跑完整启动维护 + v6 专属恢复）。

## 3. 全部 Schema（施工须精确创建）

### 3.1 availability：**保持 v5 不变**（schemaVersion 5，`schemas/availability.provider.v5.schema.json` 原样）。维护字段一律不进 availability。

### 3.2 `schemas/maintenance-profile.v6.schema.json`（sidecar，路径 `{DATA_ROOT}/maintenance/profiles/<profileId>.json`）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["schemaVersion","profileId","revision","updatedAt","episodeId","earlyBillingProbeConsumed",
    "consumedBillingSignalId","lastBillingObservedAt","lastMaintenanceProbeAt","minProbeIntervalMs",
    "availabilityRevisionSeen","availabilityStateSeen"],
  "properties":{
    "schemaVersion":{"const":6},"profileId":{"type":"string","format":"uuid"},
    "revision":{"type":"integer","minimum":0},"updatedAt":{"type":"string"},
    "episodeId":{"type":["string","null"]},"earlyBillingProbeConsumed":{"type":"boolean"},
    "consumedBillingSignalId":{"type":["string","null"]},"lastBillingObservedAt":{"type":["string","null"]},
    "lastMaintenanceProbeAt":{"type":["string","null"]},"minProbeIntervalMs":{"const":14400000},
    "availabilityRevisionSeen":{"type":["integer","null"],"minimum":0},
    "availabilityStateSeen":{"type":["string","null"]}} }
```

### 3.3 `schemas/pool-config.v6.schema.json`（`{DATA_ROOT}/pool-config.v6.json`，不进 registry/不进不可变 release）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["schemaVersion","revision","updatedAt","autoProbe","authorization"],
  "properties":{
    "schemaVersion":{"const":6},"revision":{"type":"integer","minimum":0},"updatedAt":{"type":"string"},
    "autoProbe":{"type":"object","additionalProperties":false,
      "required":["enabled","scope","quotaMaxBackoffMs","globalMaxProbesPerHour","maxProbesPerTick","minProbeIntervalMs"],
      "properties":{"enabled":{"type":"boolean"},"scope":{"const":"quota"},
        "quotaMaxBackoffMs":{"const":14400000},"globalMaxProbesPerHour":{"const":4},
        "maxProbesPerTick":{"const":2},"minProbeIntervalMs":{"const":14400000}}},
    "authorization":{"type":"object","additionalProperties":false,
      "required":["realRequestPermission","authorizationScope","authorizedProfileIds","authorizedAt","revokedAt"],
      "properties":{"realRequestPermission":{"enum":["allowed","denied"]},
        "authorizationScope":{"const":"quota-maintenance-probe"},
        "authorizedProfileIds":{"type":"array","items":{"type":"string","format":"uuid"},"uniqueItems":true},
        "authorizedAt":{"type":["string","null"]},"revokedAt":{"type":["string","null"]}}}},
  "allOf":[{"if":{"properties":{"authorization":{"properties":{"realRequestPermission":{"const":"allowed"}}}}},
    "then":{"properties":{"authorization":{"required":["authorizedAt"],
      "properties":{"authorizedAt":{"type":"string"},"authorizedProfileIds":{"minItems":1}}}}}}] }
```

### 3.4 `schemas/maintenance-task.v6.schema.json`（prompt/expect 不在数据里，由内部常量生成）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["maintenanceTaskId","profileId","kind","maxTurns","timeoutMs"],
  "properties":{"maintenanceTaskId":{"type":"string"},"profileId":{"type":"string","format":"uuid"},
    "kind":{"const":"quota-availability-probe"},"maxTurns":{"const":1},
    "timeoutMs":{"type":"integer","minimum":1,"maximum":120000}} }
```

### 3.5 `schemas/maintenance-result.v6.schema.json`
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["maintenanceInvocationId","profileId","outcome","errorClassification","end","requestId",
    "exitCode","expectedResponseMatched","usage","redaction","rawCleanup","walFinalState"],
  "properties":{
    "maintenanceInvocationId":{"type":"string","format":"uuid"},"profileId":{"type":"string","format":"uuid"},
    "outcome":{"enum":["recovered","still-exhausted","reauth","cooldown","no-op","inconclusive"]},
    "errorClassification":{"oneOf":[{"type":"null"},{"type":"object","additionalProperties":false,
      "required":["errorType","statusCode","retryable","quotaKind","profileAttributable"],
      "properties":{"errorType":{"type":"string"},"statusCode":{"type":["integer","null"]},
        "retryable":{"type":["boolean","null"]},"quotaKind":{"type":["string","null"]},
        "profileAttributable":{"type":"boolean"}}}]},
    "end":{"type":"boolean"},"requestId":{"type":["string","null"]},"exitCode":{"type":["integer","null"]},
    "expectedResponseMatched":{"type":"boolean"},"usage":{"$ref":"usage-ledger.provider.v4.schema.json#/$defs/runUsage"},
    "redaction":{"type":"object","additionalProperties":false,"required":["applied","rawStreamDeleted","rawCleanupFailed"],
      "properties":{"applied":{"type":"boolean"},"rawStreamDeleted":{"type":"boolean"},"rawCleanupFailed":{"type":"boolean"}}},
    "rawCleanup":{"enum":["deleted","failed","not-created"]},
    "walFinalState":{"enum":["completed","failed","interrupted"]}} }
```
禁止任意异常文本落盘：stderr 仅经 `redactText` 取分类结果，不存原文。

### 3.6 `schemas/maintenance-run.v6.schema.json`（WAL/reconciliation journal，路径 `{DATA_ROOT}/maintenance/runs/<maintenanceTaskId>/<invocationId>.json`）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["schemaVersion","maintenanceTaskId","maintenanceInvocationId","profileId","operation","phase",
    "status","availabilityRevisionBefore","availabilityRevisionTarget","sidecarRevisionBefore","sidecarRevisionTarget",
    "tokenReservationId","billingSignalId","resultRef","ledgerRef","createdAt","updatedAt"],
  "properties":{"schemaVersion":{"const":6},"maintenanceTaskId":{"type":"string"},
    "maintenanceInvocationId":{"type":"string","format":"uuid"},"profileId":{"type":"string","format":"uuid"},
    "operation":{"enum":["freeze","start-probe","recover","activate","clear"]},
    "phase":{"enum":["intent","availability-written","sidecar-written","finalized"]},
    "status":{"enum":["planned","running","completed","failed","interrupted"]},
    "availabilityRevisionBefore":{"type":["integer","null"]},"availabilityRevisionTarget":{"type":["integer","null"]},
    "sidecarRevisionBefore":{"type":["integer","null"]},"sidecarRevisionTarget":{"type":["integer","null"]},
    "tokenReservationId":{"type":["string","null"]},"billingSignalId":{"type":["string","null"]},
    "resultRef":{"type":["string","null"]},"ledgerRef":{"type":["string","null"]},
    "createdAt":{"type":"string"},"updatedAt":{"type":"string"}} }
```

### 3.7 `schemas/rate-bucket.v6.schema.json`（`{DATA_ROOT}/maintenance/rate-bucket.json`）
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,
  "required":["schemaVersion","capacity","tokens","windowMs","lastRefillAt","revision"],
  "properties":{"schemaVersion":{"const":6},"capacity":{"const":4},
    "tokens":{"type":"number","minimum":0,"maximum":4},"windowMs":{"const":3600000},
    "lastRefillAt":{"type":"string"},"revision":{"type":"integer","minimum":0}} }
```
**refill 算法**：`refill = capacity * (min(now,now)-lastRefillAt)/windowMs`；`tokens = min(4, tokens+refill)`；`now<lastRefillAt`（时钟回拨）→ 不补充、不透支；损坏/解析失败→fail-closed（视为 0 token）。取 token 在全局锁下 CAS；保留但未确认的 token 不退款。

### 3.8 `schemas/usage-ledger.provider.v4.schema.json`（升 v3→v4，修 v5 潜藏缺陷）
v3 的 runUsage 要求 token 为 number，但现有 `numericUsage`(provider.js:571) 对缺失 usage 产出 `present:false + null + unknown + note` → **既有 v5 记录已违反 v3 schema**。v4 用 oneOf 合法化：
```json
{ "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://grok-ui.local/schemas/usage-ledger.provider.v4.schema.json",
  "type":"object","additionalProperties":false,
  "required":["taskId","invocations","dedupKey","layers"],
  "properties":{"taskId":{"type":"string","minLength":1},
    "dedupKey":{"const":"invocation.profileId+sessionId+requestId"},
    "invocations":{"type":"array","items":{"type":"object","additionalProperties":false,
      "required":["invocationId","sessionId","requestId","variant","profileId","profileAlias","accountIdentitySnapshot","runUsage","quotaSignal"],
      "properties":{"invocationId":{"type":"string"},"sessionId":{"type":"string"},"requestId":{"type":"string"},
        "variant":{"type":"string"},"profileId":{"type":"string","format":"uuid"},"profileAlias":{"type":"string"},
        "accountIdentitySnapshot":{"type":"object"},"runUsage":{"$ref":"#/$defs/runUsage"},"quotaSignal":{"type":"object"}}}},
    "layers":{"type":"object","required":["sumRunUsage","byProfileId","profileUsageSnapshotRefs","localEstimate"]}},
  "$defs":{"runUsage":{"oneOf":[
    {"type":"object","additionalProperties":false,
     "required":["present","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage"],
     "properties":{"present":{"const":true},"input_tokens":{"type":"number"},"cache_read_input_tokens":{"type":"number"},
       "output_tokens":{"type":"number"},"reasoning_tokens":{"type":"number"},"total_tokens":{"type":"number"},"modelUsage":{"type":"object"}}},
    {"type":"object","additionalProperties":false,
     "required":["present","unknown","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage","note"],
     "properties":{"present":{"const":false},"unknown":{"const":true},"input_tokens":{"type":"null"},
       "cache_read_input_tokens":{"type":"null"},"output_tokens":{"type":"null"},"reasoning_tokens":{"type":"null"},
       "total_tokens":{"type":"null"},"modelUsage":{"type":"object"},"note":{"type":"string"}}}]}} }
```
同步 `current.json.schemaVersions.usageLedger=4`、doctor、checker。

## 4. quota vs rate-limit 的 nextProbe 分离（审计#2）
现 `computeNextProbeAt`(availability.js:143) resetAt 分支返回 `resetAt+正jitter`，`applyBillingToNextProbe`(810) 用 billingPeriodEnd 当 resetAt → 402 被推回几天；且该函数 quota/rate-limit 共用。**拆两条**：
- `computeQuotaNextProbeAt(...)`：**无论 resetAt/billingPeriodEnd 多远，最终 `nextProbeAt ≤ now+4h`**，jitter 只向下。
- `computeRateLimitNextProbeAt(...)`：**保持 v5 行为**（honor resetAt/Retry-After）。
- **所有 quota 写路径改用前者**：402 分类写入、`applyBillingToNextProbe`（quota 时）、maintenance 402 重冻结、存量迁移。rate-limit(cooldown) 路径不变。
- 存量迁移：`scope=quota` 且 `nextProbeAt>now+4h` → CAS 夹到 ≤4h；不碰 cooldown/reauth/manual_hold。

## 5. 计费信号身份 + episode 消费（审计沿用）
`billingSignalId = sha256(profileId+"|"+episodeId+"|"+billingPeriodStart+"|"+percentState)`；`percentState` 固定 `recovered_lt_95`。`lastBillingObservedAt`=单调水位，`ts≤水位`全拒。命中恢复且 `ts>水位` 且 `earlyBillingProbeConsumed=false` 才提前一次。episodeId：非 quota-frozen 态=null；进入新 quota frozen episode 生成；同 episode 402 重冻结不变。

## 6. 探针执行合同（argv 逐项数组，过 verifyPlanContract）
argv（内部常量 prompt，无裸 `--allow`，含 `--max-turns 1`）：
```json
["--no-plan","--no-memory","--output-format","streaming-json",
 "--prompt-file","<SCRATCH>/probe.prompt.txt","--cwd","<SCRATCH>",
 "--model","grok-4.5","--reasoning-effort","high",
 "--disallowed-tools","run_terminal_cmd,Agent","--no-subagents","--disable-web-search",
 "--max-turns","1","--session-id","<NEW_UUID>","--leader-socket","<SCRATCH>/leader.sock",
 "--deny","Bash","--deny","MCPTool(*)","--deny","WebFetch(*)","--deny","WebSearch"]
```
settings：dontAsk/allow 空/永久 deny(.git/.grok/.claude/runtime/Bash/MCP/Web)；env `GROK_FOLDER_TRUST` 未设、两 hooks env=false；scratch cwd 无项目文件权限；新 session、无 resume。判定复用 v5 `classifyError`：成功（真实 end+有效 requestId+exit0+expectedResponseMatched 全满足）→active；quota_exhausted→重冻结(同 episode)+§4；401→reauth_required；账号级429→cooldown；model_unavailable→no-op 不冻结；network/provider/unknown→仅 global health；timeout/cancel/crash→inconclusive 不改冻结不退 token。

## 7. 锁与 lease（审计#4，解同步 spawn 与 heartbeat 冲突）
- **maintenance 锁顺序**：`scheduler → profile(grokHome) → rate-bucket → availability/sidecar`（先确认 profile 不忙再扣 token）。
- 扩 `acquireLock`(provider.js:1231)：scheduler 固定 key 必冲突、rate-bucket 固定 key 必冲突、maintenance profile 复用 workload `grokHome` key。
- **同步 spawn 解法**：Provider 用 `spawnSync` 阻塞事件循环，**删除"持续 heartbeat"**，改为给 scheduler/profile 锁设**固定 lease > 完整任务上限**（如 15min > PT10M），配 pid/starttime 校验回收 stale lock。（备选：改异步 spawn + timer heartbeat + timeout/cancel；本合同默认取固定 lease 方案。）
- 所有 availability/sidecar 写入口共同遵守 `profile(grokHome) → availability/sidecar`（不要求 workload 取 scheduler）。

## 8. 一致性事务 + reconciliation（审计#3，确定性收敛非仅等待）
写序（consumed 在 spawn 前）：WAL `intent` → profile lock → rate token reservation → WAL `phase=availability-written`(改 availability) → WAL `phase=sidecar-written`(改 sidecar，含 availabilityRevisionSeen) → **标 billing consumed** → spawn → 写 result/ledger → WAL `finalized`/status=completed → 释放。
**启动 reconciliation（v6 专属，扫 `{DATA_ROOT}/maintenance/runs`）按 phase 确定性处理**：
- `intent`/`planned`：无副作用 → 直接标 interrupted 丢弃，不重放。
- `availability-written` 但非 `sidecar-written`：availability 已改、sidecar 未跟 → 依 journal 的 target 前滚补写 sidecar（幂等 CAS），或若 availability revision 已被他人推进则保守终止标 interrupted。
- `sidecar-written` 未 `finalized`：探针可能已 spawn → 标 interrupted，**绝不自动重放、绝不据此授 active**。
- `finalized`：完成，无需动作。
sidecar 快照校验：`availabilityRevisionSeen != 当前 availability.revision` → 保守：该账号本 tick 不授 active、不探针，先按 journal 前滚补齐；不存在"永久 pending"（每种 phase 都有明确前滚或终止动作）。

## 9. 用量归属
探针 usage 入 usage ledger（v4），`dedupKey` 沿用 `profileId+sessionId+requestId`：sessionId=探针 `--session-id`；requestId=成功取 end 真值 / 402 合成 `maint-<invocationId>`；`variant="maintenance"`；unknown usage 用 v4 的 `present:false` 分支。可被 `grok-worker usage show --profile` 汇总。

## 10. Windows 计划任务 + 安装脚本（审计#6，无占位符）
**不得**把机器名/用户硬编码进可发布 release。提供安装脚本 `deploy/install-maintenance-task.ps1`（施工须创建）：
```powershell
# 1. 动态取当前身份
$user = "$env:USERDOMAIN\$env:USERNAME"
# 2. 从模板渲染 XML（占位 {{USERID}} → $user），TimeTrigger 子元素序 StartBoundary→Enabled→Repetition，
#    Principal 含 <UserId>$user</UserId>/InteractiveToken/LeastPrivilege，
#    Action = cmd.exe /d /s /c ""<shim>" pool maintenance tick""，Settings 含 MultipleInstancesPolicy=IgnoreNew/PT10M/RestartOnFailure。
# 3. 校验渲染结果不含 'XXX'、'{{'、'<...>' 占位符，否则中止。
[IO.File]::WriteAllText($xmlPath, $rendered, [Text.UnicodeEncoding]::new($false,$true)) # 真 UTF-16LE
# 4. 默认创建为 DISABLED
schtasks /Create /TN "GrokWorkerProviderMaintenance" /XML "$xmlPath" /RU "$user" /F
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
# 5. 安装后反读校验：解析 /Query /XML 确认 UserId=$user、Interval=PT30M、IgnoreNew、LeastPrivilege、Action 为 cmd.exe 包 shim
schtasks /Query /TN "GrokWorkerProviderMaintenance" /XML
# 6. 仅当 standing authorization 成功后，另行显式 enable：
#    schtasks /Change /TN "GrokWorkerProviderMaintenance" /ENABLE
```
XML 模板 TimeTrigger 顺序 `StartBoundary→Enabled→Repetition`；`InteractiveToken`+`<UserId>` ⇒ **仅该用户登录时运行**（施工机长期登录可接受，登出全自动须存凭据 → 安全线禁止，不做）。

## 11. 回滚（可执行命令，sidecar 免迁移）
```bat
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
schtasks /Delete /TN "GrokWorkerProviderMaintenance" /F
```
pointer 原子回滚（切回 previousVersion）：
```powershell
$cur = Get-Content "$env:LOCALAPPDATA\GrokWorkerProvider\current.json" | ConvertFrom-Json
$prevPath = "$env:LOCALAPPDATA\GrokWorkerProvider\releases\$($cur.previousVersion)\current-snapshot.json"
# 原子替换 current.json 为 previousVersion 对应指针（含 releasePath/dataRoot/registryPath/manifestSha256）
Copy-Item $prevPath "$env:LOCALAPPDATA\GrokWorkerProvider\current.json.tmp"
Move-Item -Force "$env:LOCALAPPDATA\GrokWorkerProvider\current.json.tmp" "$env:LOCALAPPDATA\GrokWorkerProvider\current.json"
```
v5 不读 `maintenance/` 子树 → 回滚后四账号 availability 状态保留。

## 12. 验收矩阵
| 项 | 验收 |
|---|---|
| 单文件事实源 | r6 无"参见 r4/r5"依赖；全 schema 完整 |
| quota 4h 真硬上限 | resetAt=7天后仍 nextProbeAt≤now+4h；rate-limit cooldown 行为不变；402 分类/billing/maint 重冻结/迁移四路径全走 quota 函数 |
| reconciliation 收敛 | 每 phase 有确定性前滚或终止；无永久 pending；不重放不误授 active |
| 同步 spawn | 无 heartbeat 依赖；固定 lease>PT10M；stale lock 回收 |
| ledger v4 | present:true→number、present:false→null/unknown/note 各自 oneOf 通过；usage show 可汇总 |
| 计划任务无占位符 | 安装脚本动态渲染 $USERDOMAIN\$USERNAME；校验无 XXX/{{；真 UTF-16LE；默认 disabled；/Query 反读；可执行 pointer 回滚 |
| argv/XML | argv 含 --max-turns 1 无裸 --allow；XML StartBoundary→Enabled→Repetition+UserId+cmd.exe 包 shim |
| 授权硬门 | config 缺失/非法/撤销/profile 不在集合→零请求硬失败 |
| 锁序/token | scheduler→profile→rate-bucket→availability；profile 忙不扣 token；保留不退款；回拨不透支；损坏 fail-closed |
| 默认 harness | 100% mock，零真请求 |

## 13. 流程门
1. r6 独立终审 PASS；2. 实现 schema/代码/fixture/安装脚本；3. 默认 mock 独立审计；4. 单独授权 live canary；5. 单独授权 standing authorization + enable 计划任务。
