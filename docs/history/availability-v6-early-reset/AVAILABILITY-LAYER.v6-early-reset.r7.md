# v6-r7：自动早重置恢复（唯一事实源，单文件自包含）

> **本文件是唯一事实源。r2–r6 仅历史证据，施工不得引用。** 基于已施工 v5，只加 quota 冻结账号自动早重置恢复。
> Owner 约束：quota 退避硬上限 4h；自动、不靠人工。安全线：计费只作机会性提示；只有真实探针成功才授 active；不读/复制 auth.json。
> 定稿日期：2026-07-21

## 1. 固定参数
quota 退避硬上限 ≤4h（含 resetAt/billing 分支，jitter 只向下）；scheduler 30min；**严格 ≤4 探针/滚动 1h**；maxProbesPerTick=2；每 profile 盲探最小间隔 4h；单探针 ≤120s；两探针+清理 <10min；计费 `creditUsagePercent<95` 或新 `billingPeriodStart` 晚于冻结 → `percentState=recovered_lt_95`，每冻结 episode 至多提前一次，永不授 active；autoProbe.enabled 默认 false；authorization.realRequestPermission 默认 denied；reauth_required/manual_hold 永不自动探针；PROBE_PROMPT/PROBE_EXPECT 为 Provider 内部常量。

## 2. 命令面
`main()` 先 parseArgs。只读命令（version/doctor/pool status/profiles list）纯只读快路径（幂等 ensureDir，不 cleanupOrphanRaw/recoverInterruptedRuns/ensureDefaultProfile、不写）。变更类新增：`pool maintenance tick`、`pool config authorize|revoke|status`（见 §8）。

## 3. Schema

### 3.1 availability：保持 v5 不变。
### 3.2 maintenance-profile v6（sidecar `{DATA_ROOT}/maintenance/profiles/<profileId>.json`）
字段同 r6（schemaVersion 6；episodeId 可空；earlyBillingProbeConsumed；consumedBillingSignalId；lastBillingObservedAt；lastMaintenanceProbeAt；minProbeIntervalMs const 14400000；availabilityRevisionSeen；availabilityStateSeen），`additionalProperties:false`。
### 3.3 pool-config v6：同 r6（autoProbe 全 const：globalMaxProbesPerHour=4/maxProbesPerTick=2/minProbeIntervalMs=14400000；authorization allOf if allowed then authorizedAt 非空+authorizedProfileIds minItems 1），`additionalProperties:false`。
### 3.4 maintenance-task v6：同 r6（kind const；maxTurns const 1；timeoutMs [1,120000]；无可编辑 prompt）。
### 3.5 maintenance-result v6：同 r6（additionalProperties:false；errorClassification 定型 oneOf null|对象；usage ref v4 runUsage；redaction；rawCleanup enum deleted/failed/not-created）。

### 3.6 maintenance-run journal v6（审计#3，细化 phase + 目标内容）
路径 `{DATA_ROOT}/maintenance/runs/<maintenanceTaskId>/<invocationId>.json`。phase 细化为：`intent → availability-intent → availability-written → sidecar-intent → sidecar-written → finalized`。**journal 必须保存前滚所需目标内容**：
```json
{ "schemaVersion":6,"maintenanceTaskId":"...","maintenanceInvocationId":"<uuid>","profileId":"<uuid>",
  "operation":{"enum":["freeze","start-probe","recover","activate","clear"]},
  "phase":{"enum":["intent","availability-intent","availability-written","sidecar-intent","sidecar-written","finalized"]},
  "status":{"enum":["planned","running","completed","failed","interrupted"]},
  "availabilityBefore":{"revision":"int|null"},"availabilityTarget":{"state":"...","scope":"...","nextProbeAt":"...","evidence":{}},
  "sidecarBefore":{"revision":"int|null"},"sidecarTarget":{"episodeId":"...","earlyBillingProbeConsumed":true,"...":"完整目标对象"},
  "tokenSlotId":"...","billingSignalId":"...","resultRef":"...","ledgerRef":"...","createdAt":"...","updatedAt":"..." }
```
每 phase 条件 schema：`availability-intent` 起 `availabilityTarget` 必填；`sidecar-intent` 起 `sidecarTarget` 必填。`additionalProperties:false`。

### 3.7 rate 严格滑动窗口（审计#5，替换 token bucket）
`{DATA_ROOT}/maintenance/rate-window.json`：`{schemaVersion:6, requests:[ISO...], windowMs:3600000, maxInWindow:4, revision}`。
- **严格 ≤4/滚动 1h**：新探针前全局锁下读窗口，剔除 `ts < now-3600000`，`requests.length >= 4` → 拒绝（本 tick 不探该账号）；否则 append `now`、CAS 写。
- 时钟回拨：`now` 早于窗口内最新 ts 时不 append、不探；损坏/解析失败 → fail-closed（视为已满）。
- 保留 slot 后崩溃：不回滚该 ts（宁可少探，不重复真实请求）。

### 3.8 usage-ledger v4（审计#1，两种真实生产形状都通过）
`numericUsage`(provider.js:610) 成功产出 `{present:true, unknown:false, ..., note:null}`，缺失产出 `{present:false, unknown:true, ...null, note:"usage-unknown"}`。v4 runUsage oneOf 两分支**都按真实形状**：
```json
"runUsage":{"oneOf":[
 {"type":"object","additionalProperties":false,
  "required":["present","unknown","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage","note"],
  "properties":{"present":{"const":true},"unknown":{"const":false},
    "input_tokens":{"type":"number"},"cache_read_input_tokens":{"type":"number"},"output_tokens":{"type":"number"},
    "reasoning_tokens":{"type":"number"},"total_tokens":{"type":"number"},"modelUsage":{"type":"object"},"note":{"type":"null"}}},
 {"type":"object","additionalProperties":false,
  "required":["present","unknown","input_tokens","cache_read_input_tokens","output_tokens","reasoning_tokens","total_tokens","modelUsage","note"],
  "properties":{"present":{"const":false},"unknown":{"const":true},
    "input_tokens":{"type":"null"},"cache_read_input_tokens":{"type":"null"},"output_tokens":{"type":"null"},
    "reasoning_tokens":{"type":"null"},"total_tokens":{"type":"null"},"modelUsage":{"type":"object"},"note":{"type":"string"}}}]}
```
dedupKey 沿用 `invocation.profileId+sessionId+requestId`；同步 `current.json.schemaVersions.usageLedger=4`、doctor、checker。**验收须对现有真实成功+402 两类记录各跑一次校验通过**。

## 4. 计费读取扩展（审计#2）
- `BILLING_CTX_WHITELIST` **增** `creditUsagePercent`、`billingPeriodStart`（当前只有 billingPeriodEnd/periodEnd/resetAt/usedPercent/quotaUsedPercent/status）。
- `readBillingSnapshot` 返回合同**增** `creditUsagePercent:number|null`、`billingPeriodStart:ISO|null`、`percentState`（`creditUsagePercent<95` → `"recovered_lt_95"`，否则 null）。
- 只读 `ctx.config` 白名单字段；校验百分比数值/时间戳/周期格式；**保留** reparse 拒绝、`BILLING_MAX_LINES_SCAN`、行长上限、secret-key 拒绝、只读 profile 自身 grokHome。
- 计费信号只提前探针（§5），永不授 active。

## 5. quota nextProbe 分离 + 计费信号
- `computeQuotaNextProbeAt(...)`：**resetAt/billingPeriodEnd 多远都 `≤now+4h`**，jitter 只向下。所有 quota 写路径（402 分类、applyBillingToNextProbe(quota)、maintenance 402 重冻结、存量迁移）改用之。
- `computeRateLimitNextProbeAt(...)`：保持 v5（honor resetAt/Retry-After）。cooldown 不变。
- 存量迁移：`scope=quota` 且 `nextProbeAt>now+4h` → CAS 夹 ≤4h。
- `billingSignalId=sha256(profileId+"|"+episodeId+"|"+billingPeriodStart+"|"+percentState)`；`lastBillingObservedAt` 单调水位拒 `ts≤水位`；命中 + `ts>水位` + `earlyBillingProbeConsumed=false` → 提前一次。

## 6. 探针执行 + 强制隔离入口（审计#7）
- **必须复用 v5 `isolatedEnv(profile, invocationHome, socket)`**(provider.js:308)：`GROK_HOME=profile.grokHome`；`HOME/USERPROFILE/LOCALAPPDATA=invocationHome`；删 XAI_API_KEY/GROK_FOLDER_TRUST/GROK_SANDBOX；加 `GROK_CLAUDE_HOOKS_ENABLED=false`/`GROK_CURSOR_HOOKS_ENABLED=false`。
- 复用 v5 路径守卫：`PATH_DEFAULT_GROK_HOME`（禁默认 ~/.grok 及父子）、`INV1_AUTH_READ_FORBIDDEN`（禁读/复制 auth.json）。scratch cwd/socket/session 单次隔离、无 resume。
- argv（内部常量 prompt、无裸 `--allow`、含 `--max-turns 1`）：
```json
["--no-plan","--no-memory","--output-format","streaming-json","--prompt-file","<SCRATCH>/probe.prompt.txt",
 "--cwd","<SCRATCH>","--model","grok-4.5","--reasoning-effort","high","--disallowed-tools","run_terminal_cmd,Agent",
 "--no-subagents","--disable-web-search","--max-turns","1","--session-id","<NEW_UUID>","--leader-socket","<SCRATCH>/leader.sock",
 "--deny","Bash","--deny","MCPTool(*)","--deny","WebFetch(*)","--deny","WebSearch"]
```
settings dontAsk/allow 空/永久 deny；过等价 `verifyPlanContract`。判定复用 v5 `classifyError`：成功(真实 end+requestId+exit0+expectedResponseMatched)→active；quota→重冻结(同 episode)+§5；401→reauth_required；账号429→cooldown；model_unavailable→no-op；network/provider/unknown→仅 global health；timeout/crash→inconclusive 不改冻结不退 slot。

## 7. 锁 + 一致性事务 + reconciliation（审计#3）
- 锁序 `scheduler → profile(grokHome) → rate-window → availability/sidecar`；扩 acquireLock 认 scheduler/rate-window scope；maintenance profile 用 workload `grokHome` key；同步 spawn → 固定 lease>PT10M（15min），无 heartbeat 依赖。
- **写序（consumed 在 spawn 前，细化 phase）**：WAL `intent` → profile lock → 占 rate slot → WAL `availability-intent`(存 availabilityTarget) → 写 availability(CAS) → WAL `availability-written` → WAL `sidecar-intent`(存 sidecarTarget) → 写 sidecar(CAS，含 availabilityRevisionSeen) → WAL `sidecar-written` → 标 billing consumed → spawn → 写 result/ledger → WAL `finalized`/completed → 释放。
- **启动 reconciliation（v6 专属，扫 maintenance/runs，按 phase 确定性前滚/终止）**：
  - `intent`/`availability-intent`：业务文件未改 → 标 interrupted 丢弃。
  - `availability-written` 未 `sidecar-written`：用 journal 的 `sidecarTarget` **前滚补写 sidecar**（幂等 CAS）→ finalized；若 availability.revision 已被他人推进(≠ availabilityTarget 依据) → 保守标 interrupted。
  - `sidecar-written` 未 `finalized`：探针可能已 spawn → 标 interrupted，**绝不重放、绝不据此授 active**。
  - `finalized`：无动作。
  - 无"永久 pending"：每 phase 均有明确前滚或终止。

## 8. 自动维护控制面（审计#6，闭合，不靠手编 JSON）
- **授权命令（原子，走 pool-config CAS）**：
  - `grok-worker pool config authorize --profiles <id;id> [--scope quota-maintenance-probe]` → 写 `authorization.realRequestPermission=allowed`、`authorizedProfileIds`、`authorizedAt=now`、`revokedAt=null` + 追加授权审计记录。
  - `grok-worker pool config revoke` → `realRequestPermission=denied`、`revokedAt=now` + 审计记录。
  - `grok-worker pool config status` → 只读当前授权/autoProbe/审计摘要（零请求）。
- **候选排序与选择**：`probeEligible` 按 `nextProbeAt → lastMaintenanceProbeAt → profileId`，取前 `maxProbesPerTick=2`。**池中有 active 仍维护 quota-frozen**（早重置恢复的目的即此）。
- **退出码**：config 缺失→非硬失败(视为 enabled:false，零请求正常退出)；config 损坏/非法→硬失败非零退出、零请求；授权硬门任一不满足→零请求硬失败。
- **`pool maintenance tick` 输出 Result 汇总**：本次扫描账号数、计费提前命中、探针发起/结果、slot 用量、跳过原因。

## 9. Windows 计划任务 — 完整 XML 模板 + 安装脚本（审计#4）
### 9.1 `deploy/GrokWorkerProviderMaintenance.template.xml`（占位 `{{USERID}}`、`{{START_BOUNDARY}}`）
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Grok Worker Provider quota early-reset maintenance</Description></RegistrationInfo>
  <Triggers><TimeTrigger>
    <StartBoundary>{{START_BOUNDARY}}</StartBoundary>
    <Enabled>true</Enabled>
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
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>C:\Windows\System32\cmd.exe</Command>
    <Arguments>/d /s /c ""%USERPROFILE%\.local\bin\grok-worker.cmd" pool maintenance tick"</Arguments>
    <WorkingDirectory>%USERPROFILE%\AppData\Local\GrokWorkerProvider</WorkingDirectory>
  </Exec></Actions>
</Task>
```
### 9.2 `deploy/install-maintenance-task.ps1`（完整、无占位符残留）
```powershell
$ErrorActionPreference = "Stop"
$user = "$env:USERDOMAIN\$env:USERNAME"
$root = "$env:LOCALAPPDATA\GrokWorkerProvider"
$tpl  = Join-Path $PSScriptRoot "GrokWorkerProviderMaintenance.template.xml"
$out  = Join-Path $root "GrokWorkerProviderMaintenance.xml"
$start = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$xml = (Get-Content -Raw $tpl) -replace "{{USERID}}",$user -replace "{{START_BOUNDARY}}",$start
if ($xml -match "{{|}}|DESKTOP-XXX|<\.\.\.>|XXX\\") { throw "unrendered placeholder remains" }
[IO.File]::WriteAllText($out, $xml, [Text.UnicodeEncoding]::new($false,$true))  # 真 UTF-16LE
schtasks /Create /TN "GrokWorkerProviderMaintenance" /XML "$out" /RU "$user" /F
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE   # 默认 disabled
# 反读校验
$q = (schtasks /Query /TN "GrokWorkerProviderMaintenance" /XML) -join "`n"
foreach ($need in @("<UserId>$user</UserId>","PT30M","IgnoreNew","LeastPrivilege","cmd.exe","pool maintenance tick")) {
  if ($q -notmatch [regex]::Escape($need)) { throw "post-install verify missing: $need" }
}
Write-Host "installed (disabled). enable only after standing authorization."
```
### 9.3 enable/disable/uninstall
```bat
schtasks /Change /TN "GrokWorkerProviderMaintenance" /ENABLE
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
schtasks /Delete /TN "GrokWorkerProviderMaintenance" /F
```
`InteractiveToken`+`<UserId>` ⇒ 仅该用户登录时运行（施工机长期登录可接受；登出全自动须存凭据 → 安全线禁止，不做）。

## 10. 回滚（复用现有原子 pointer 写，审计#4）
- **发布时**：每个 release 目录写自身指针快照 `releases/<version>/pointer.json`（由发布流程用 `buildCurrentPointer`(provider.js:1470) 生成，含 version/releasePath/dataRoot/registryPath/schemaVersions/manifestSha256）。
- **回滚**：`schtasks /Change ... /DISABLE` → `schtasks /Delete ... /F` → 用 Provider **现有** `atomicWriteJson`(fsync+rename 原子) 将 `releases/<previousVersion>/pointer.json` 写为 `current.json`（不用 Copy/Move）。
- v5 不读 `maintenance/` 子树 → 四账号 availability 状态保留。

## 11. 验收矩阵（可执行）
| 项 | 验收 |
|---|---|
| ledger v4 双形状 | 现有真实成功记录(present:true/unknown:false/note:null)+402(present:false/unknown/note) 各校验通过 |
| 计费可生成 | 白名单含 creditUsagePercent/billingPeriodStart；readBillingSnapshot 返回 + percentState；守卫保留 |
| quota 4h 真上限 | resetAt=7天后仍 ≤now+4h；四条写路径全走 quota 函数；cooldown 不变 |
| 严格限流 | 滑动窗口 ≤4/滚动1h（含突发场景）；回拨不透支；损坏 fail-closed |
| journal 前滚 | 每个写间隙断电 → 按 phase 前滚补写或保守终止；无永久 pending；不重放不误授 active |
| 隔离入口 | 强制 isolatedEnv；PATH_DEFAULT_GROK_HOME/INV1_AUTH_READ_FORBIDDEN 生效；无默认 ~/.grok/auth.json |
| 控制面 | authorize/revoke/status 原子命令+审计；候选排序 nextProbeAt→lastProbeAt→profileId 取2；config 缺失非硬失败/损坏硬失败退出码；tick Result 汇总 |
| 计划任务 | 脚本渲染无占位符残留(含守卫)、真 UTF-16LE、默认 disabled、/Query 反读校验、TimeTrigger 序 StartBoundary→Enabled→Repetition、cmd.exe 包 shim |
| 回滚 | release 时生成 pointer.json；回滚复用 atomicWriteJson；四账号状态保留 |
| 默认 harness | 100% mock，零真请求 |

## 12. 流程门
1. r7 独立终审 PASS；2. 实现 schema/代码/fixture/安装脚本；3. 默认 mock 独立审计（含 §11 全部可执行验收）；4. 单独授权 live canary；5. 单独授权 standing authorization + enable 计划任务。
