# Grok Worker — Availability / 冻结池 施工合同 v5（完整独立版）

> 前置合同：`GROK-WORKER-PROVIDER.plan.md`（已 PASS，安全骨架不改）
> 取代 v1–v4 全部（均施工前终审 FAIL）。**本文件为唯一权威、自包含施工合同**，施工线程只读本文件，无需回查旧版。
> 定稿日期：2026-07-21

---

## 0. 锚定事实（五轮真实探针+终审后不可动摇的前提）

1. 耗尽**分类语义**已确认：`status_code=402` + `is_retryable=false` + `Grok Build usage balance exhausted`（账号 example-tertiary）。
2. 该证据来自隔离 profile 的 `unified.jsonl`；当时 Provider 丢弃了 stderr → **`execution.stderr` 的真实耗尽载荷格式尚未观测**，不得假设。
3. `unified.jsonl` = 官方"Internal log files"（`14-headless-mode.md:526`），仅辅助/历史佐证，非主真值源、非 fixture 原样来源。
4. 真实调用前会被 Provider 自身 `INSPECT_AUTHORITY/externalCompatHooks` 拦（需 §9 环境变量）。
5. `grok models` 能过 ≠ 账号可用（四账号都过但 example-tertiary 仍 402）→ 解封只认最小真实请求成功。
6. UTF-16 已排除（真实 spawnSync utf8 正确解析）→ 仅保留回归测试。
7. 现有 `runTask` 分类前就释放锁（provider.js:496-498）→ 有竞态，须重写（§6）。
8. task-capsule、result-capsule 均 `additionalProperties:false`；command-plan 非之 → 加字段须同步改 schema + `validateResultCapsule`（§2）。

---

## 1. 目录与部署决定（Owner 定案）

- **唯一权威源码仓库**：`<provider-repository>`
- **版本化部署目录**：`%LOCALAPPDATA%\GrokWorkerProvider\releases\<version>`（不可变）
- **当前版本指针**：`%LOCALAPPDATA%\GrokWorkerProvider\current.json`
- **全局稳定入口**：`%USERPROFILE%\.local\bin\grok-worker.cmd`（固定引导器，日常发布**不改**）
- **Codex skill**：`%USERPROFILE%\.codex\skills\grok-worker-pool`
- `<legacy-consumer-root>\.codex\grok-bridge\provider`：只读迁移源/历史镜像，**不再是权威源码**。
- **四个现有 profile 暂留** `%LOCALAPPDATA%\GrokUI\codex-grok-workers`。禁止复制/读取/哈希/软链 `auth.json`；未来迁入新中立 profile root 只能逐账号重走官方 OAuth。

---

## 2. 数据模型与 Schema 变更

### 2.1 availability 记录（新增，独立 ledger）
`{DATA_ROOT}/availability/{profileId}.json`，profileId 主键，仅脱敏元数据，过 `hasSecretKeys` + `atomicWriteJson`：
```
schemaVersion, revision(CAS 防旧覆盖新), updatedAt, evidenceSource,
state, scope, evidence{errorType,statusCode,retryable,observedAt,resetAt,billingHint},
nextProbeAt, lastSelectedAt
```
状态枚举（7 态）：`active | frozen | cooldown | probe_due | manual_hold | unknown | reauth_required`。

### 2.2 task-capsule schema（改）
- 顶层 `required` 不再无条件强制 `profile`，改 `oneOf`：
  - **explicit** → `profile`(alias) 必填；
  - **pool** → `candidateProfileIds` 必填（**不可变 profileId，非 alias**），`profile` 禁止或 null。
- `failover.allowedFallbackProfiles`(alias) → 升级 `allowedFallbackProfileIds`(profileId)，禁止混用。
- 新增 `probePolicy`（§4.2）。

### 2.3 result-capsule schema（改，仍 additionalProperties:false）
- 新增：选中 `profileId`、`selectionEvidence`（候选/跳过原因/最终选中）、`errorClassification`（§5）。
- 同步改 `validateResultCapsule`(provider.js:683)。

### 2.4 command-plan schema（改，非 additionalProperties:false，加字段易）
- 新增 `selectionMode`、`candidateProfileIds`、`skippedReasons`、是否追加 maintenance probe 的标志。

### 2.5 task-run schema（新增，多 attempt 事务外层）
`task-run.provider.v5.schema.json`：
```
runId, taskId, status(planned|running|completed|failed|interrupted),
attempts[]（每项引用一次独立 Result Capsule 的 ref），
finalSelectedProfileId, finalResultRef, takeoverRequired, createdAt, updatedAt
```

---

## 3. 状态机与确定性推进

### 3.1 冻结/进入触发（§5 归因边界之后）
- `quota_exhausted` → `frozen`(scope=quota)
- `reauth_required` → `reauth_required`（独立态）
- 带账号级证据或可信 Retry-After 的 `rate_limited` → `cooldown`(scope=rate_limit)
- 非账号错误（network/provider/unknown/无证据 429）→ **不碰 profile availability**（§5）

### 3.2 nextProbeAt 必设规则
冻结/cooldown 写入时**必须**生成 `nextProbeAt`：
- 有经校验的可信 resetAt（如 billingPeriodEnd 过时效校验）→ resetAt + 抖动。
- `resetAt:null` → 由指数退避策略生成 nextProbeAt（否则永不到期、永不解封）。

### 3.3 确定性本地推进（选择时求值，不由实现临时猜）
```
active                          → workloadEligible
unknown                         → probeEligible
frozen  且 now <  nextProbeAt   → excluded
frozen  且 now >= nextProbeAt   → probe_due → probeEligible
cooldown 且 now <  nextProbeAt  → excluded
cooldown 且 now >= nextProbeAt  → probe_due → probeEligible
reauth_required / manual_hold   → excluded
```

### 3.4 bootstrap / 现有四账号迁移
- 最近成功 Result Capsule → `active`（带 observedAt）。
- 已确认 402 的 example-tertiary → `frozen/quota/resetAt:null`（依 §12 受控历史证据做一次显式 bootstrap）。
- 无可靠证据的新 profile → `unknown`（不伪装 active，走 probeEligible）。

### 3.5 reauth_required 专属规则
- 永不自动真实探针、永不自动切号或复制认证。
- 仅当用户明确完成该 profile 官方 OAuth 后：先 `grok models` 验认证，**再**做一次真实 availability probe；OAuth 成功本身不直接授 active。

---

## 4. 候选选择与探针授权

### 4.1 候选集合（§3.3 求值结果）
- `workloadEligible`：仅 active。
- `probeEligible`：unknown、或到期的 probe_due（含到期 frozen/cooldown）。
- `excluded`：未到期 frozen/cooldown、reauth_required、manual_hold。

### 4.2 probePolicy（显式授权，杜绝隐藏真实请求）
task-capsule 新增：
```json
{ "probePolicy": { "mode": "disabled|when-no-active|after-workload",
                   "realRequestPermission": "allowed|denied", "maxProbesPerRun": 1 } }
```
规则：
- 默认 `disabled`。
- `plan` 必须展示本次是否会追加 maintenance probe。
- 普通 workload 的 `realRequestPermission:allowed` **不**自动授权额外 maintenance probe（探针需 probePolicy 自己的 realRequestPermission）。
- 探针有独立 Capsule/Result/usage，用 `grok-4.5/high/--no-plan/--no-memory/--max-turns 1`；每 profile 单飞、全局频率上限、指数退避+抖动。
- `pool refresh --real allowed` 可独立触发探针。
- 池内没有 active 时，pool run 才可按显式 policy 用 probeEligible 自救。
- `profiles list`/`pool status`/`plan` 永远**零请求**。

---

## 5. 错误分类与归因边界
- 内存解析 + 脱敏 `execution.stderr`（`redactText`，不落 raw），输出 `{statusCode,errorType,retryable,quotaKind}`。
- 七类：`quota_exhausted`/`rate_limited`/`reauth_required`/`model_unavailable`/`network_fault`/`provider_fault`/`unknown_failure`。
- **只有** profile 可归因错误改 profile availability：`quota_exhausted`、`reauth_required`、带账号级证据/可信 Retry-After 的 `rate_limited`。
- 其余（network/provider/unknown/无证据 429）→ **只写 invocation 结果 + 独立 provider/global health 状态，绝不碰 profile availability**。
- 无法识别的 exit 1 一律 `unknown_failure`，**不冻结**（见 §12 INCONCLUSIVE）。

---

## 6. 执行与锁生命周期（重写 runTask）+ WAL
执行序列（消除 provider.js:496-498 竞态）：
1. **spawn 前**先写 WAL：`{DATA_ROOT}/runs/{taskId}/{runId}.json` = `planned`。
2. selection lock 下选 profile + 建 reservation；WAL→`running`。
3. 获取 profile lock。
4. 释放 selection reservation。
5. 获取 workspace lock 并执行。
6. **仍持 profile lock 时**：分类错误 + 写 availability（带 revision CAS）。
7. 释放 workspace/profile lock。
8. 落 Result/usage；WAL→`completed|failed`。

锁扩展：`acquireLock` 定义 `availability`/`selection` scope 冲突语义（现只判 profile/workspace 会跳过新 scope）；reservation lease 覆盖"选中→取运行锁"整段；锁顺序 selection→profile→workspace 防死锁。

**崩溃恢复**：启动扫描遗留 `running` WAL → 只标 `interrupted`，**不得**凭空重建成功结果；每次 attempt 的 Result/usage 永不覆盖。

---

## 7. 多 Worker Failover 事务（attempts[]）
- 每次账号尝试独立 `invocationId` + Result Capsule + usage。
- task-run（§2.5）记 `attempts[]`（引用各 Result）、最终 status、`finalSelectedProfileId`、`takeoverRequired`。
- 402 尝试的 usage 保持 `unknown`，**不得记 0**。
- failover 不复用前一账号的 Grok session；同任务 usage 按 invocation 去重。
- 自动换下一 Worker 仅当：明确 402 + 无输出 + 无工具事件 + `changedFilesFinalState=[]`；有部分修改 → controller-continuation / Codex 接管。
- 禁止旧失败 Result 被后续成功 Result 静默覆盖。

---

## 8. 计费信号（辅助快照，硬化）
- 只读 profile 自身 `grokHome/logs`，拒 reparse/symlink；文件大小、单行长度、扫描条数上限；容忍轮转/半写/坏尾行。
- 按解析后 `ts` 选最新有效记录（非物理最后一行）；从 `ctx.config` **严格白名单重建**新对象（`hasSecretKeys` 只查字段名不查值，不足）。
- `billingPeriodEnd` **只影响 `nextProbeAt`，永不直接授 active**；fixture 人工最小合成。

---

## 9. 环境前提（G-0）
- `isolatedEnv()` 注入进程级 `GROK_CLAUDE_HOOKS_ENABLED=false`、`GROK_CURSOR_HOOKS_ENABLED=false`；`planTemplate`/`verifyPlanContract` 断言存在；不改用户/系统环境；不靠调用者手补。

---

## 10. 测试
- 默认 harness/mutation：100% fixture/mock，**零真实请求**。
- opt-in live canary：单账号、单回合、明确 `realRequestPermission:allowed`；耗尽账号非到 `nextProbeAt` 不重探；live canary 失败不得伪造默认 checker 的 FAIL/PASS。
- fixture：402 归因、七类分型、非账号错误不碰 profile、候选集三分（含 cooldown/到期 frozen 转 probe_due）、reservation 防并撞、CAS 防旧覆盖新、WAL 崩溃恢复、attempts[] 事务、explicit 不被替换、probePolicy 默认 disabled；保留 UTF-16 回归。

---

## 11. 部署流程（单指针原子）
- `grok-worker.cmd` 固定引导器，日常发布不改；shim 每次**读取并校验** `current.json`。
- 新版本完整写入不可变 release 目录 → 校验清单 + SHA-256 → **只原子替换 `current.json`**（回滚亦只切 `current.json`）。
- `current.json` 记：`version`、`releasePath`、`previousVersion`、`dataRoot`、`registryPath`、`schemaVersions`、`manifestSha256`。
- 现有 credential-bearing profile/数据继续用旧路径；新安装**从指针读旧 `dataRoot/registryPath`**，不得因代码换目录而"看不见"四个账号。
- 更新 skill 后再停用旧安装路径。

---

## 12. 残余风险 / INCONCLUSIVE 验收项（合同显式承认）
- 官方 reset 时间无法由 headless CLI 稳定获得 → quota frozen 默认 `resetAt:null` + 退避 probe（§3.2）。
- `unified.jsonl` 内部实现细节 → 仅辅助。
- **`execution.stderr` 耗尽载荷格式未观测**：可实现保守 parser，但 synthetic fixture 只证明解析器行为；验收项"未来所有耗尽都能自动识别"**保持 INCONCLUSIVE 未关闭**，直到首次自然耗尽或到期 probe 捕获真实 stderr 后才关闭。**禁止假 PASS**。核心池可先投入使用。

---

## 13. 施工分批
- **批1**：§9 G-0、§5 分类+归因边界、§2.1+§3 状态层+确定性推进+bootstrap、§6 锁生命周期+WAL。
- **批2**：§2.2–2.5 schema 命名空间、§4 候选+probePolicy、§7 failover 事务。
- **批3**：§8 计费辅助快照、§11 版本化部署落地。

---

## 14. 施工前终审清单
逐条对照：§3.3 确定性推进（含 cooldown + nextProbeAt 必设）、§4.2 probePolicy 显式授权、§2.5+§6 task-run schema+WAL、§11 单指针原子部署。四项 PASS + 无新增范围，才允许施工。
