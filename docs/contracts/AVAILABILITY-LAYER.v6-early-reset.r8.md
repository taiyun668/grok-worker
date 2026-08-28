# v6-r8：自动早重置恢复（唯一事实源，全 Schema 展开）

> **本文件是唯一事实源，自包含。不引用 r2–r7（仅历史）。** 基于已施工 v5，只加 quota 冻结账号自动早重置恢复。
> Owner 约束：quota 退避硬上限 4h；自动、不靠人工。安全线：计费只作机会性提示；只有真实探针成功才授 active；不读/复制 auth.json；强制复用 v5 `isolatedEnv`。
> 定稿日期：2026-07-21

## 1. 固定参数
quota 退避硬上限 ≤4h（含 resetAt/billing 分支，jitter 只向下）；scheduler 30min；严格 ≤4 探针/滚动 1h；maxProbesPerTick=2；盲探最小间隔 4h；单探针 ≤120s；两探针+清理 <10min；计费 `creditUsagePercent<95`→`percentState=recovered_lt_95`，每 episode 至多提前一次，永不授 active；三门（授权/autoProbe/计划任务）默认全关；reauth_required/manual_hold 永不自动探针；`PROBE_PROMPT="Reply with exactly: grok-availability-ok"`、`PROBE_EXPECT="grok-availability-ok"`（内部常量）。

## 2. 命令面
`main()` 先 parseArgs。只读快路径（version/doctor/pool status/profiles list/**pool config status**/**deploy list**）：幂等 ensureDir，不 cleanupOrphanRaw/recoverInterruptedRuns/ensureDefaultProfile、不写。变更类：`pool maintenance tick`、`pool config authorize|revoke`、`pool config autoprobe --enable|--disable`、`deploy rollback`。

## 3. 全部 Schema（可直接提取为 .schema.json）

### 3.1 availability：**不变**，沿用仓库现存 `schemas/availability.provider.v5.schema.json`（schemaVersion 5）。维护字段一律不进 availability。

### 3.2 `schemas/maintenance-profile.v6.schema.json`
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/maintenance-profile.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["schemaVersion","profileId","revision","updatedAt","episodeId","freezeObservedAt","episodePeriodStart",
   "earlyBillingProbeConsumed","consumedBillingSignalId","lastBillingObservedAt","lastMaintenanceProbeAt",
   "minProbeIntervalMs","availabilityRevisionSeen","availabilityStateSeen"],
 "properties":{
   "schemaVersion":{"const":6},"profileId":{"type":"string","format":"uuid"},
   "revision":{"type":"integer","minimum":0},"updatedAt":{"type":"string"},
   "episodeId":{"type":["string","null"]},"freezeObservedAt":{"type":["string","null"]},
   "episodePeriodStart":{"type":["string","null"]},"earlyBillingProbeConsumed":{"type":"boolean"},
   "consumedBillingSignalId":{"type":["string","null"]},"lastBillingObservedAt":{"type":["string","null"]},
   "lastMaintenanceProbeAt":{"type":["string","null"]},"minProbeIntervalMs":{"const":14400000},
   "availabilityRevisionSeen":{"type":["integer","null"],"minimum":0},
   "availabilityStateSeen":{"type":["string","null"]}}}
```

### 3.3 `schemas/pool-config.v6.schema.json`
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/pool-config.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["schemaVersion","revision","updatedAt","autoProbe","authorization","auditLog"],
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
       "authorizedAt":{"type":["string","null"]},"revokedAt":{"type":["string","null"]}}},
   "auditLog":{"type":"array","items":{"type":"object","additionalProperties":false,
     "required":["at","action","actorNote"],
     "properties":{"at":{"type":"string"},"action":{"enum":["authorize","revoke","autoprobe-enable","autoprobe-disable"]},
       "actorNote":{"type":"string"}}}}},
 "allOf":[{"if":{"properties":{"authorization":{"properties":{"realRequestPermission":{"const":"allowed"}}}}},
   "then":{"properties":{"authorization":{"required":["authorizedAt"],
     "properties":{"authorizedAt":{"type":"string"},"authorizedProfileIds":{"minItems":1}}}}}}]}
```

### 3.4 `schemas/maintenance-task.v6.schema.json`
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/maintenance-task.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["maintenanceTaskId","profileId","kind","maxTurns","timeoutMs"],
 "properties":{"maintenanceTaskId":{"type":"string","minLength":1},"profileId":{"type":"string","format":"uuid"},
   "kind":{"const":"quota-availability-probe"},"maxTurns":{"const":1},
   "timeoutMs":{"type":"integer","minimum":1,"maximum":120000}}}
```

### 3.5 `schemas/maintenance-result.v6.schema.json`
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/maintenance-result.v6.schema.json",
 "type":"object","additionalProperties":false,
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
   "expectedResponseMatched":{"type":"boolean"},
   "usage":{"$ref":"usage-ledger.provider.v4.schema.json#/$defs/runUsage"},
   "redaction":{"type":"object","additionalProperties":false,"required":["applied","rawStreamDeleted","rawCleanupFailed"],
     "properties":{"applied":{"type":"boolean"},"rawStreamDeleted":{"type":"boolean"},"rawCleanupFailed":{"type":"boolean"}}},
   "rawCleanup":{"enum":["deleted","failed","not-created"]},
   "walFinalState":{"enum":["completed","failed","interrupted"]}}}
```

### 3.6 `schemas/maintenance-run.v6.schema.json`（WAL/journal，路径 `{DATA_ROOT}/maintenance/runs/<maintenanceTaskId>/<invocationId>.json`）
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/maintenance-run.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["schemaVersion","maintenanceTaskId","maintenanceInvocationId","profileId","operation","phase","status",
   "availabilityBefore","availabilityTarget","sidecarBefore","sidecarTarget",
   "tokenSlotTs","billingSignalId","resultRef","ledgerRef","createdAt","updatedAt"],
 "properties":{
   "schemaVersion":{"const":6},"maintenanceTaskId":{"type":"string"},
   "maintenanceInvocationId":{"type":"string","format":"uuid"},"profileId":{"type":"string","format":"uuid"},
   "operation":{"enum":["freeze","start-probe","recover","activate","clear"]},
   "phase":{"enum":["intent","availability-committed","sidecar-committed","finalized"]},
   "status":{"enum":["planned","running","completed","failed","interrupted"]},
   "availabilityBefore":{"type":["object","null"]},"availabilityTarget":{"type":["object","null"]},
   "sidecarBefore":{"type":["object","null"]},"sidecarTarget":{"type":["object","null"]},
   "tokenSlotTs":{"type":["string","null"]},"billingSignalId":{"type":["string","null"]},
   "resultRef":{"type":["string","null"]},"ledgerRef":{"type":["string","null"]},
   "createdAt":{"type":"string"},"updatedAt":{"type":"string"}}}
```

### 3.7 `schemas/rate-window.v6.schema.json`（`{DATA_ROOT}/maintenance/rate-window.json`）
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/rate-window.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["schemaVersion","requests","windowMs","maxInWindow","revision"],
 "properties":{"schemaVersion":{"const":6},
   "requests":{"type":"array","items":{"type":"string"}},
   "windowMs":{"const":3600000},"maxInWindow":{"const":4},"revision":{"type":"integer","minimum":0}}}
```
严格 ≤4/滚动1h：全局锁下剔除 `ts<now-3600000`，`requests.length>=4`→拒；否则 append `now`+CAS。时钟回拨(`now<最新ts`)不 append 不探；损坏→fail-closed（视为满）；占位后崩溃不回滚该 ts。

### 3.8 `schemas/usage-ledger.provider.v4.schema.json`
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
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
    "required":["present","unknown","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage","note"],
    "properties":{"present":{"const":true},"unknown":{"const":false},"input_tokens":{"type":"number"},
      "cache_read_input_tokens":{"type":"number"},"output_tokens":{"type":"number"},"reasoning_tokens":{"type":"number"},
      "total_tokens":{"type":"number"},"modelUsage":{"type":"object"},"note":{"type":"null"}}},
   {"type":"object","additionalProperties":false,
    "required":["present","unknown","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage","note"],
    "properties":{"present":{"const":false},"unknown":{"const":true},"input_tokens":{"type":"null"},
      "cache_read_input_tokens":{"type":"null"},"output_tokens":{"type":"null"},"reasoning_tokens":{"type":"null"},
      "total_tokens":{"type":"null"},"modelUsage":{"type":"object"},"note":{"type":"string"}}}]}}}
```

### 3.9 `schemas/deploy-pointer.v6.schema.json`（`{DATA_ROOT}/deploy/pointers/<version>.json` 与 `current.json`）
```json
{"$schema":"https://json-schema.org/draft/2020-12/schema",
 "$id":"https://grok-ui.local/schemas/deploy-pointer.v6.schema.json",
 "type":"object","additionalProperties":false,
 "required":["version","releasePath","previousVersion","dataRoot","registryPath","approvedProfileRoot","schemaVersions","manifestSha256","updatedAt"],
 "properties":{"version":{"type":"string"},"releasePath":{"type":"string"},"previousVersion":{"type":["string","null"]},
   "dataRoot":{"type":"string"},"registryPath":{"type":"string"},"approvedProfileRoot":{"type":"string"},
   "schemaVersions":{"type":"object"},"manifestSha256":{"type":"string"},"updatedAt":{"type":"string"}}}
```

## 4. 计费读取扩展（审计#2 已通过方向，含 #6 基准）
- `BILLING_CTX_WHITELIST` 增 `creditUsagePercent`、`billingPeriodStart`。
- `readBillingSnapshot` 返回增 `creditUsagePercent:number|null`、`billingPeriodStart:ISO|null`、`percentState`（`<95`→`recovered_lt_95` 否则 null）。
- 保留 reparse/大小/行长/secret-key 拒绝、只读 profile 自身 grokHome、`BILLING_MAX_LINES_SCAN`。

## 5. quota nextProbe 分离 + 计费信号基准（审计#6）
- `computeQuotaNextProbeAt`：resetAt/billing 多远都 `≤now+4h`（jitter 向下）；`computeRateLimitNextProbeAt` 保持 v5。四条 quota 写路径（402 分类/applyBillingToNextProbe(quota)/maintenance 402/迁移）用前者。
- 存量迁移：`scope=quota` 且 `nextProbeAt>now+4h` → CAS 夹 ≤4h。
- **episode 创建时写 `freezeObservedAt`、`episodePeriodStart`**（当前已知周期起点）。
- `billingSignalId=sha256(profileId+"|"+episodeId+"|"+billingPeriodStart+"|"+percentState)`。
- **提前探针必须同时满足**：`billing.ts > freezeObservedAt` **且** `billing.billingPeriodStart > episodePeriodStart` **且** `billing.ts > lastBillingObservedAt`（单调水位）**且** `earlyBillingProbeConsumed=false`。任一不满足不提前。首次建 sidecar 的历史 `<95%` 记录因 `billingPeriodStart` 不新于基准而被拒。

## 6. 探针执行 + 强制隔离（审计已通过）
强制复用 v5 `isolatedEnv(profile, invocationHome, socket)`(provider.js:308)：GROK_HOME=grokHome、HOME/USERPROFILE/LOCALAPPDATA=invocationHome、删 XAI_API_KEY/GROK_FOLDER_TRUST/GROK_SANDBOX、加两 hooks env=false；复用 `PATH_DEFAULT_GROK_HOME`/`INV1_AUTH_READ_FORBIDDEN`；scratch/socket/session 单次隔离无 resume。argv（内部常量 prompt、无裸 `--allow`、含 `--max-turns 1`）：
```json
["--no-plan","--no-memory","--output-format","streaming-json","--prompt-file","<SCRATCH>/probe.prompt.txt",
 "--cwd","<SCRATCH>","--model","grok-4.5","--reasoning-effort","high","--disallowed-tools","run_terminal_cmd,Agent",
 "--no-subagents","--disable-web-search","--max-turns","1","--session-id","<NEW_UUID>","--leader-socket","<SCRATCH>/leader.sock",
 "--deny","Bash","--deny","MCPTool(*)","--deny","WebFetch(*)","--deny","WebSearch"]
```
过等价 `verifyPlanContract`。判定复用 v5 `classifyError`：成功(真实 end+requestId+exit0+expectedResponseMatched)→active；quota→重冻结(同 episode)+§5；401→reauth_required；账号429→cooldown；model_unavailable→no-op；network/provider/unknown→仅 global health；timeout/crash→inconclusive 不改冻结不退 slot。

## 7. 一致性事务 + 三态恢复（审计#2，消除 phase 滞后窗口）
锁序 `scheduler → profile(grokHome) → rate-window → availability/sidecar`；扩 acquireLock 认 scheduler/rate-window；maintenance profile 用 workload grokHome key；同步 spawn → 固定 lease 15min(>PT10M)，无 heartbeat。
**写序（两 target 在任何业务写之前一次性持久化）**：
1. WAL `phase=intent`，**同时**写入 `availabilityBefore/availabilityTarget/sidecarBefore/sidecarTarget`（完整目标对象）+ status=running。
2. 占 rate slot（记 tokenSlotTs）。
3. 写 availability（CAS，expected=availabilityBefore.revision）→ WAL `phase=availability-committed`。
4. 写 sidecar（CAS，含 availabilityRevisionSeen）→ WAL `phase=sidecar-committed`。
5. 标 billing consumed → spawn → 写 result/ledger → WAL `phase=finalized`/status=completed → 释放。
**启动 reconciliation（v6 专属，扫 maintenance/runs，按三态比较 current/before/target，不靠 phase 猜）**：对 availability 与 sidecar **各自**：
- `current==before` → 未写 → 用 target CAS 前滚补写。
- `current==target` → 已写 → 视为该文件完成。
- `current` 既非 before 也非 target（第三方推进）→ **保守终止**：status=interrupted，**不前滚、不授 active**。
两文件都达 target 后置 finalized；任一被第三方推进即整体 interrupted。无永久 pending。

## 8. 自动维护控制面（审计#3，三门 + 候选收窄）
**三个独立门（各带 auditLog）**：
- `grok-worker pool config authorize --profiles <id;id>` → realRequestPermission=allowed、authorizedProfileIds、authorizedAt、revokedAt=null。
- `grok-worker pool config autoprobe --enable|--disable` → autoProbe.enabled true/false。
- 计划任务 enable：`schtasks /Change ... /ENABLE`（§9）。
- `grok-worker pool config revoke` → denied + revokedAt。
- `grok-worker pool config status` → **走 §2 只读快路径**，输出授权/autoProbe/审计摘要，零请求。
**维护候选收窄**：仅 `authorization` 授权集合内 ∩ `scope=quota` ∩ (frozen 且到期 | probe_due)。**排除** unknown、过期 cooldown、未授权 profile。排序 `nextProbeAt→lastMaintenanceProbeAt→profileId`，取前 maxProbesPerTick=2。池中有 active 仍维护 quota-frozen。
**退出码**：config 缺失→非硬失败（enabled 视为 false，零请求正常退出 0）；config 损坏/非法/授权门任一不满足→硬失败非零、零请求。
`pool maintenance tick` 输出 Result 汇总（扫描数/计费命中/探针结果/slot 用量/跳过原因）。

## 9. 计划任务 — 中立模板 + 安装脚本（审计#4）
### 9.1 `deploy/GrokWorkerProviderMaintenance.template.xml`（占位 `{{USERID}}/{{START_BOUNDARY}}/{{SHIM_PATH}}/{{WORKING_DIR}}`，默认不运行）
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Grok Worker Provider quota early-reset maintenance</Description></RegistrationInfo>
  <Triggers><TimeTrigger>
    <StartBoundary>{{START_BOUNDARY}}</StartBoundary><Enabled>true</Enabled>
    <Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
  </TimeTrigger></Triggers>
  <Principals><Principal id="Author">
    <UserId>{{USERID}}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>
  </Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT5M</Interval><Count>1</Count></RestartOnFailure>
    <Enabled>false</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>C:\Windows\System32\cmd.exe</Command>
    <Arguments>/d /s /c ""{{SHIM_PATH}}" pool maintenance tick"</Arguments>
    <WorkingDirectory>{{WORKING_DIR}}</WorkingDirectory>
  </Exec></Actions>
</Task>
```
`Settings/Enabled=false` ⇒ 创建即不运行，无"创建后短暂运行窗口"。
### 9.2 `deploy/install-maintenance-task.ps1`（每步查 $LASTEXITCODE）
```powershell
$ErrorActionPreference="Stop"
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name   # DOMAIN\User，机器中立
$shim="$env:USERPROFILE\.local\bin\grok-worker.cmd"
$wd="$env:LOCALAPPDATA\GrokWorkerProvider"
$start=(Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$esc={param($s)($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;')}
$tpl=Get-Content -Raw (Join-Path $PSScriptRoot "GrokWorkerProviderMaintenance.template.xml")
$xml=$tpl -replace "{{USERID}}",(&$esc $user) -replace "{{START_BOUNDARY}}",$start `
          -replace "{{SHIM_PATH}}",(&$esc $shim) -replace "{{WORKING_DIR}}",(&$esc $wd)
if($xml -match "{{|}}"){throw "unrendered placeholder"}
$out=Join-Path $wd "GrokWorkerProviderMaintenance.xml"
[IO.File]::WriteAllText($out,$xml,[Text.UnicodeEncoding]::new($false,$true))  # 真 UTF-16LE
schtasks /Create /TN "GrokWorkerProviderMaintenance" /XML "$out" /RU "$user" /F
if($LASTEXITCODE -ne 0){throw "create failed"}
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
if($LASTEXITCODE -ne 0){throw "disable failed — do NOT report success"}
$q=(schtasks /Query /TN "GrokWorkerProviderMaintenance" /XML) -join "`n"
foreach($n in @([regex]::Escape("<UserId>$user</UserId>"),"PT30M","IgnoreNew","LeastPrivilege","cmd.exe","pool maintenance tick")){
  if($q -notmatch $n){throw "post-install verify missing: $n"}}
Write-Host "installed (disabled). enable only after standing authorization."
```
（`Settings/Enabled=false` 模板 + 安装即 `/DISABLE` 双保险；`InteractiveToken`+`<UserId>` ⇒ 仅该用户登录时运行，登出全自动须存凭据→安全线禁止，不做。）

## 10. 发布指针 + 可执行回滚（审计#5）
现场核对：release 目录只有 `release-manifest.json`，无 pointer.json，故指针存**可变**目录 `{DATA_ROOT}/deploy/pointers/<version>.json`（不改不可变 release）。
- **发布时**：用 `buildCurrentPointer`(provider.js:1470) 生成目标版本 pointer 写 `{DATA_ROOT}/deploy/pointers/<version>.json`（经 deploy-pointer schema 校验），再原子写 current.json。**回填**现有 `1.0.0-086062c`、`1.0.0-3d469c0` 两版 pointer。
- **`grok-worker deploy rollback --to <version>`**（受控入口，非内部函数）：
  1. 读 `{DATA_ROOT}/deploy/pointers/<version>.json`，校验 schema + `releasePath` 存在 + `manifestSha256` 与该 release 的 `release-manifest.json` 一致 + dataRoot/registryPath 合法。
  2. 校验失败 → 非零退出，**current.json 保持原值**。
  3. 校验通过 → 用现有 `atomicWriteJson`(fsync+rename) 将该 pointer 写为 current.json。
  4. 回滚前应先 `schtasks /Change ... /DISABLE`（§9.3）。
- `grok-worker deploy list` → 只读列出可回滚版本（快路径）。
- v5 不读 `maintenance/` 子树 → 回滚后四账号 availability 状态保留。
### 9.3 enable/disable/uninstall
```bat
schtasks /Change /TN "GrokWorkerProviderMaintenance" /ENABLE
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
schtasks /Delete /TN "GrokWorkerProviderMaintenance" /F
```

## 11. 验收矩阵（可执行）
| 项 | 验收 |
|---|---|
| 全 Schema 可提取 | §3.2–3.9 每份能单独存为 .schema.json 并解析通过；无"同 rN"引用 |
| ledger v4 双形状 | 现有真实成功(present:true/unknown:false/note:null)+402(present:false/unknown/note) 各通过 |
| 三态恢复 | 每个写间隙断电：current==before→前滚；==target→完成；皆非→interrupted 不授 active；无永久 pending |
| 计费基准 | 首建 sidecar 历史<95% 因 billingPeriodStart 不新于 episodePeriodStart 被拒；三条件全满足才提前 |
| quota 4h | resetAt=7天后仍≤now+4h；四写路径全走 quota 函数；cooldown 不变 |
| 严格限流 | 滑动窗口≤4/滚动1h（含突发）；回拨不透支；损坏 fail-closed |
| 控制面三门 | authorize/autoprobe/task-enable 独立+审计；候选仅授权∩quota∩(frozen到期|probe_due)；status 走只读；config 缺失0/损坏非0 |
| 计划任务中立 | {{SHIM_PATH}}/{{WORKING_DIR}} 渲染；Settings/Enabled=false；每 schtasks 查 $LASTEXITCODE；/DISABLE 失败不报成功；真 UTF-16LE；/Query 反读 |
| 回滚可执行 | 发布写+回填 pointers/<ver>.json；deploy rollback 校验 manifestSha256；失败 current.json 不变 |
| 隔离红线 | 强制 isolatedEnv；无默认 ~/.grok/auth.json |
| 默认 harness | 100% mock，零真请求 |

## 12. 流程门
1. **r8 独立终审 PASS → 立即转施工**；2. 实现 schema/代码/fixture/安装脚本；3. 默认 mock 独立审计（跑 §11 全部）；4. 单独授权 live canary；5. 单独授权 standing authorization（三门）+ enable 计划任务。
