# v6-r5：自动早重置恢复（自包含施工合同，收紧 8 项执行/一致性缺口）

> 基于 v5。取代 r4（终审 FAIL，含两执行错误）。施工只读本文件 + r4 中已 PASS 的未变部分（Sidecar 架构、复用 v5 分类器、grokHome 锁键、401/429/non-attributable 分支、120s/2-per-tick、登录态限制说明、pool status 只读）。
> 定稿日期：2026-07-21

## r4 已 PASS（不再改）
Sidecar 不升 availability schema；availability 保持 v5；探针复用 v5 `classifyError`；maintenance profile lock 用 `profile.grokHome`；探针非 402 分支（401→reauth/账号429→cooldown/model_unavailable→不冻结/network/provider/unknown→仅 global health）；单探针≤120s、maxProbesPerTick=2；无密码计划任务仅登录态运行（已诚实标注）；`pool status` 纯只读。

## 修 1：CLI argv（r4#1，执行错误）
- **删除** `--allow`（Grok 文档 14-headless-mode.md:35 要求 `--allow <RULE>` 必带规则；空 allow = 不传该 flag）。
- **补** `--max-turns 1`（schema 要求 maxTurns:1，r4 argv 漏了）。
- prompt 由 Provider **内部常量**生成（见修 5），不来自可编辑数据。
- argv **逐项数组生成**，禁止从展示文本拆分。最终数组：
```json
["--no-plan","--no-memory","--output-format","streaming-json",
 "--prompt-file","<SCRATCH>/probe.prompt.txt","--cwd","<SCRATCH>",
 "--model","grok-4.5","--reasoning-effort","high",
 "--disallowed-tools","run_terminal_cmd,Agent","--no-subagents","--disable-web-search",
 "--max-turns","1","--session-id","<NEW_UUID>","--leader-socket","<SCRATCH>/leader.sock",
 "--deny","Bash","--deny","MCPTool(*)","--deny","WebFetch(*)","--deny","WebSearch"]
```
isolated settings：`defaultMode=dontAsk`、allow 空数组、永久 deny(.git/.grok/.claude/runtime/Bash/MCP/Web)；env `GROK_FOLDER_TRUST` 未设、`GROK_CLAUDE_HOOKS_ENABLED=false`、`GROK_CURSOR_HOOKS_ENABLED=false`。过等价 `verifyPlanContract` 才算成功。

## 修 2：Sidecar↔availability 一致性事务（r4#2）
- sidecar 精确路径 `{DATA_ROOT}/maintenance/profiles/<profileId>.json`。
- sidecar 增快照字段：`availabilityRevisionSeen`(int)、`availabilityStateSeen`(enum)——记录写 sidecar 时所依据的 availability 版本/态。
- **intent WAL**（见修 7 路径）先落，再改 availability + sidecar；两者写入同一 `profile(grokHome)` 锁下。
- **启动 reconciliation**（v6 自己跑）：
  - availability=active → sidecar `episodeId=null`、`earlyBillingProbeConsumed=false`（清 episode）。
  - availability=quota-frozen 而 sidecar 缺失/episode 空 → **保守新建** episode（不授 active）。
  - `availabilityRevisionSeen != 当前 availability.revision` 或状态不一致 → 标 `reconcile-pending`，**该账号本 tick 不授 active、不探针**，下 tick 重评。
- **补 r4 漏项**：一次性 CAS 夹断——`scope=quota` 且 `nextProbeAt>now+4h` 的存量 availability 记录夹到 ≤4h（不碰 cooldown/reauth/manual_hold）。

## 修 3：consumed 必须在 spawn 之前（r4#3）
同步 spawn 无法在"子进程已启动、请求未发"间插可靠持久写，故安全顺序（宁可少提前一次，绝不重复真实请求）：
1. maintenance WAL `planned`；
2. profile lock（grokHome）；
3. rate token reservation（CAS 扣）；
4. WAL `running`（spawn-intent）；
5. **标 billing signal `consumed`**（写 sidecar `earlyBillingProbeConsumed=true`）；
6. spawn；
7. 崩溃恢复：`running`→`interrupted`，**绝不自动重放**。
4h 盲探兜底覆盖"少提前一次"的损失。

## 修 4：maintenance 专用锁顺序（r4#4，修正自相矛盾）
- **顺序**：`scheduler → profile(grokHome) → rate-bucket → availability/sidecar`（先确认 profile 不忙，再扣 token，解决 r4"忙不扣 token"与"rate-bucket→profile"矛盾）。
- 扩 `acquireLock`（provider.js:1231）：`scheduler` 同固定 key 必冲突；`rate-bucket` 同固定 key 必冲突；maintenance profile 复用 workload 的 `profile.grokHome` key（互斥同一 profile）；**lock heartbeat 失败则不得继续 spawn**。
- 修正 r4 过宽表述："所有 availability 写入口先取 scheduler"**不可行**（workload 无 scheduler lock）→ 改为：所有写入口共同遵守 `profile(grokHome) → availability/sidecar`；scheduler/rate-bucket 仅 maintenance 路径涉及。

## 修 5：schema 收紧为 const + prompt 内部常量（r4#5）
- `pool-config.v6`：`globalMaxProbesPerHour` `const:4`；`maxProbesPerTick` `const:2`；`minProbeIntervalMs` `const:14400000`；`authorization` 用 if/then——`realRequestPermission=allowed` 时 `authorizedAt` 非空、`authorizedProfileIds` `minItems:1`。
- `rate-bucket.v6`：`tokens` `minimum:0, maximum:4`。
- `maintenance-task.v6`：**移除可编辑 prompt/expectedResponse**——由 Provider 内部常量生成（`PROBE_PROMPT="Reply with exactly: grok-availability-ok"`、`PROBE_EXPECT="grok-availability-ok"`），防 standing authorization 被替换成任意真实请求越权；`maxTurns const:1`、`timeoutMs` `minimum:1, maximum:120000`。
- **新增 maintenance WAL schema** `maintenance-run.v6.schema.json`：`{schemaVersion:6, maintenanceTaskId, maintenanceInvocationId, profileId, status:enum[planned,running,completed,failed,interrupted], createdAt, updatedAt}`，`additionalProperties:false`。

## 修 6：maintenance-result 收紧 + ledger 兼容（r4#6）
- `maintenance-result.v6`：`additionalProperties:false`；`errorClassification` 用**定型对象**（复用 v5 归因字段 `{errorType,statusCode,retryable,quotaKind,profileAttributable}` 或 null），非任意 object；`usage` 用 ledger 的 `runUsage` 定型；增 `redaction`(applied/notes/rawStreamDeleted/rawCleanupFailed)；`rawCleanup` 枚举增 `not-created`；禁止任意异常文本落盘（stderr 仅经 `redactText` 后取分类结果，不存原文）。
- **ledger 兼容(不升 v3 schema)**：沿用现有 `dedupKey="invocation.profileId+sessionId+requestId"`；探针写 ledger 用真实 `sessionId`(探针 `--session-id`) + `requestId`(成功取 end 事件真值；402 无 requestId → 合成 `maint-<invocationId>`)；`variant="maintenance"`。**unknown usage 用现有约定 `present:false`**（`rebuildLayers` 计入 `invocationsUnknown`、**不累加进 total** = 不记 0）。维护用量因此能被 `grok-worker usage show --profile` 正常汇总。

## 修 7：maintenance WAL 独立目录（r4#7，回滚安全）
- 现 `recoverInterruptedRuns`(availability.js:688) 扫 `{DATA_ROOT}/runs/**` 所有 JSON、见 `status:"running"` 即改 interrupted+takeoverRequired、**不验 schemaVersion** → maintenance WAL 绝不能放这里。
- maintenance WAL 路径：`{DATA_ROOT}/maintenance/runs/<maintenanceTaskId>/<invocationId>.json`，由 **v6 专属恢复函数** 处理；v5 的 recoverInterruptedRuns 不触及 `maintenance/` 子树 → 回滚安全成立。

## 修 8：Task Scheduler XML 修正（r4#8）
### 8.1 修正后 XML（`deploy/GrokWorkerProviderMaintenance.xml`，**须按 UTF-16LE 写盘**）
```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Grok Worker Provider quota early-reset maintenance</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2026-07-21T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>DESKTOP-XXX\Ayun</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT5M</Interval><Count>1</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Windows\System32\cmd.exe</Command>
      <Arguments>/d /s /c ""%USERPROFILE%\.local\bin\grok-worker.cmd" pool maintenance tick"</Arguments>
      <WorkingDirectory>%USERPROFILE%\AppData\Local\GrokWorkerProvider</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```
关键修正：① `TimeTrigger` 子元素顺序 `StartBoundary→Enabled→Repetition`（官方 schema 要求 Enabled 在 Repetition 前）；② 增 `<UserId>` 机器绑定当前用户；③ 用 `cmd.exe /d /s /c` 包 `.cmd` shim（ExecAction.Path 应为可执行文件）；④ 文件须真按 UTF-16LE 写盘，与声明一致。
### 8.2 命令（含安装后反读校验 + 回滚）
```bat
:: install（/RU 绑定用户）
schtasks /Create /TN "GrokWorkerProviderMaintenance" /XML "deploy\GrokWorkerProviderMaintenance.xml" /RU "DESKTOP-XXX\Ayun" /F
:: 安装后反读校验
schtasks /Query /TN "GrokWorkerProviderMaintenance" /XML
:: disable / enable / uninstall
schtasks /Change /TN "GrokWorkerProviderMaintenance" /DISABLE
schtasks /Change /TN "GrokWorkerProviderMaintenance" /ENABLE
schtasks /Delete /TN "GrokWorkerProviderMaintenance" /F
```
### 8.3 完整回滚顺序
1. `schtasks /Change ... /DISABLE`（先停计划任务）；
2. `schtasks /Delete ... /F`（如需彻底移除）；
3. 切 release pointer：将 `current.json` 原子替换回 `previousVersion` 对应 release（含 releasePath/dataRoot/registryPath/manifestSha256）；
4. sidecar 无需迁移（v5 不读 `maintenance/` 子树）。

## 验收矩阵（增量项）
| 项 | 验收 |
|---|---|
| argv 合法 | 含 `--max-turns 1`、无裸 `--allow`；数组逐项；过 verifyPlanContract |
| sidecar 一致性 | 快照版本不符→reconcile-pending 不授 active；availability active→sidecar 清 episode；崩溃后启动 reconciliation |
| 存量夹断 | quota 且 nextProbeAt>now+4h 迁移到≤4h |
| consumed 顺序 | consumed 在 spawn 前落盘；崩溃→interrupted 不重放 |
| 锁顺序 | scheduler→profile→rate-bucket→availability；profile 忙不扣 token；heartbeat 失败不 spawn |
| schema const | 4/2/14400000/tokens≤4/timeout∈[1,120000]/allowed 时 authorizedAt 非空且 profiles≥1 |
| prompt 内部常量 | 无可编辑 prompt；越权真实请求不可能 |
| result 收紧 | additionalProperties:false；定型 errorClassification/usage；redaction；rawCleanup 含 not-created；无原始 stderr 落盘 |
| ledger 兼容 | 现有 dedupKey；真实/合成 sessionId+requestId；unknown=present:false 不计 total；usage show 可汇总 |
| WAL 隔离 | maintenance WAL 在 maintenance/runs；v5 recoverInterruptedRuns 不触及 |
| XML 合法 | 元素顺序 StartBoundary→Enabled→Repetition；有 UserId；cmd.exe 包 shim；UTF-16LE；/Query 反读校验 |
| 回滚 | 停任务→切 pointer 完整命令；sidecar 免迁移 |

## 门（沿用 r4 纠正后的流程）
1. r5 施工合同独立终审 PASS；2. 实现 schema/代码/fixture/调度资产；3. 默认 mock 独立审计；4. 单独授权 live canary；5. 单独授权 standing authorization + 装计划任务。
