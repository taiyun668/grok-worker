# GROK-WORKER-PROVIDER 施工计划（门禁版 · v7 施工前终审修订）

> 执行合同，不是提案。未过某门禁验收前不得进入下一门禁；红线不得违反。
> v7 针对 Codex 第五次终审的 1 安全模型阻塞 + hash 收紧 + 1 非阻塞定点修订（架构 G0–G9 不变）。folder-trust 语义已逐字核实。

## 修订记录（v7 · 采纳第五次终审）
- [F1] **folder-trust 语义纠正**（文档核实：`GROK_FOLDER_TRUST=0` 是**拆门=ungate**，让未受信项目 hooks/MCP/LSP 反而运行，与 v6 理解相反）。**删除 `GROK_FOLDER_TRUST=0`**。改为：folder-trust **保持启用** + 隔离 profile 用**空的、Provider 托管的 trust store**（`trusted_folders.toml` 空→项目默认未受信→项目 hooks 静默跳过）；Provider **永不传 `--trust`**；run 前确认目标项目**不在**该 profile 的 trusted-folders；隔离 config 明设 `[compat.claude] hooks=false`、`[compat.cursor] hooks=false`（关 Claude/Cursor hook 扫描）；项目原生 `.grok/hooks/** `、MCP/LSP、authority-bearing permission 配置由 preflight **硬失败**；用 `grok inspect --json` 只读验证**最终生效**配置，发现未授权 hook/MCP/plugin/permission 来源即禁止 materialize/run。
- [F2] **hash 放行收紧**：hash 只证内容未变、不证不扩权。含 permission-allow/hook/MCP/plugin/folder-trust 的配置**不得仅凭 hash 放行**，须通过**语义检查证明其有效权限 ⊆ Provider 策略**；首版最安全做法=**直接硬失败**；hash allowlist 仅用于**不影响权限**的普通配置。
- [F3 非阻塞] 首版 schema 的 `agents/mcp/web` **只接受 `denied`**；未来开放时再加具体 agent/MCP server-tool/web domain allowlist，不设宽泛 `allowed`。

## 修订记录（v6 · 采纳第四次终审）
- [E1] 权限拒绝模型重建（文档核实：项目 `.claude/settings*.json` **会被合并**、项目 allow 参与；PreToolUse hook 超时/崩溃 **fail-open**）。真正拒绝基础 = **`dontAsk`(无 allow 即拒) + deny 规则恒胜(`deny>ask>allow`，不论来源) + preflight 中和项目 allow 注入**；PreToolUse 降为**审计与第二道防线**，不作主闸。补：~~子进程固定 `GROK_FOLDER_TRUST=0`~~（**此项被 v7 [F1] 作废并纠正——见下方 F1，那是拆门不是禁门**）、禁加载非 Provider 插件、preflight 扫描项目 `.grok/config.toml`+`.claude/settings*.json`+hooks/MCP（发现扩权配置则硬失败；hash 放行规则见 F2）、**永久 deny Worker 写 `.git/** .grok/** .claude/**` 与 Provider runtime**、hook timeout/crash mutation（即便 fail-open，越界写仍被 dontAsk 拒）。
- [E2] 官方快照按 profile 存储：全局 `usage/profiles/<profileId>/snapshots.jsonl`，Task 查询按 invocation.profileId 联结；G7 命令显式收 `--profile`，`source/capturedAt/accountBinding` 绑定到 profileId（解 failover 后双账号快照）。
- [E3~E7 非阻塞] 删顶层重复 `oauthReady`（只留 `authReadiness.oauthReady`）；G9 加 `grok-worker roots list/register/inspect` 并修正示例路径为占位符；G2 将 `contextRefs` 编译为**只读**权限；控制器执行 `acceptanceCommands` 时 Result Capsule 标 `executedBy: controller`（防 Worker 虚报测试）；每次 run 校验 model/reasoning 仍在最新 capability snapshot 内（不靠旧缓存猜测）。

## 修订记录（v5 · 采纳第三次终审）
- [D1] Ledger 归属重构：顶层只留 task 信息；**每个 invocation 携带 `profileId/profileAlias/accountIdentitySnapshot`**；去重键取该 invocation 的 `profileId+sessionId+requestId`；聚合新增 `byProfileId`；failover 前后调用各归各 profile。
- [D2] headless 审批策略（经 `22-permissions-and-safety.md` 核实：`--permission-mode dontAsk` 被接受但**不生效**；headless 弹窗调用直接取消）：G2 增加**每 invocation 隔离 HOME 内生成受控 `.claude/settings.json`**（`permissions.defaultMode="dontAsk"` + 仅允许 Capsule 路径的 allow 规则）+ **provider-owned PreToolUse 边界钩子**作硬约束 + mutation 证明"允许路径能写、越界在工具执行前被拒"。
- [D3] Bash 合同收紧：删除 `allowed-with-patterns`；Windows Provider 仅 `denied|controller-only`，controller-only 命令绝不进 Grok argv/toolset。固定合同补（经 `14-headless-mode.md` 核实）：`--disallowed-tools run_terminal_cmd`、默认 `--no-subagents`、Agent/MCP/Web 工具受 Capsule 策略控制、项目自身 `.grok/config.toml`/`.claude/settings*.json`/hooks 不得扩权、恶意项目配置负向夹具。
- [D4] 越界证据拆两层：`changedFilesFinalState`（worktree 内 tracked/untracked/ignored 最终状态）+ `policyAuditEvents`（PreToolUse guard 记录并**执行前拒绝**越界写入）。"写仓库外/先改后恢复"由 guard 前置拦截验证，不再要求 Git 事后 diff 发现（该要求不可实现，v4 表述作废）。
- [D5] plan/run 执行语义：`grok-worker plan` 永不 spawn；`grok-worker run` 仅接受 `realRequestPermission=allowed`，`denied` 在 spawn 前硬失败；`serviceControlPermission/gitPermission/forbiddenActions` 编译进工具过滤+permission rules+PreToolUse guard；每字段配 mutation（删 enforcement 后 checker 必须失败）。

## 修订记录（v4 · 采纳第二次终审）
- [C1] G2 拆为 `planTemplate`（确定性、逐字节可比）+ `materializedInvocationPlan`（唯一 socket/invocationId/temp 路径/时间等运行态字段，只查结构与唯一性）。
- [C2] 注册不可变 `profileId`（UUID）作数据库主键；去重键改 `profileId + sessionId + requestId`；账号 identity 仅作归属快照，不作主键（解 INV-5↔INV-6）。
- [C3] 解耦 auth readiness 与 identity 验证：OAuth 就绪独立可验；CLI 能给稳定身份才 verified，否则 unknown/unverified 但用 profileId 分账；G9 不强制 verified；G7 绑不上记 `unbound/unsupported`，不伪造、不阻塞基础 Provider。
- [C4] INV-7 表述修正：changed-files 是**越界检测与失败判据，非预防性 sandbox**。写隔离靠 exclusive-worktree + baseCommit 干净基线校验 + provider 生成 Edit/Write 路径 deny + Grok Worker Bash 恒 denied；检测须覆盖 tracked/untracked/ignored；`controller-only` Bash = 控制器另行执行、绝不向 Worker 暴露 Bash。
- [C5] temp raw 崩溃安全：优先流式内存解析；若落盘则受限 ACL + finally 删除 + Provider 启动清孤儿 + timeout/kill/crash 负向夹具 + 清理失败在 Result Capsule 硬失败告警。
- [C6] Capsule/Result 建**独立 Provider v3 schema**：完整复用既有 `$defs`、显式列扩展字段、保持旧 schema（`additionalProperties:false`）不变，不用 allOf 硬加。
- [C7] S1 路径安全进 G0 负向验收：junction/reparse、`..`、大小写变体、默认 `.grok` 父子目录、UNC/device path。

> 以下为 v3 基线正文，已内联上述 v4 修订。

## 修订记录（v3 · 采纳终审）
- [核实] Windows sandbox 无 OS enforcement：官方 `~/.grok/docs/user-guide/18-sandbox.md` Platform Support 仅 Linux(Landlock)/macOS(Seatbelt)，无 Windows；"无法应用即 warning 后无 enforcement 继续"。故 v2 把 `--sandbox` 当访问边界是错误，v3 纠正。
- [核实] 现有 schema 更完整：`tools/codex-grok-bridge/schemas/task-capsule.schema.json`（16 必填）与 `result-capsule.schema.json`（tests/findings/…/boundaryCompliance）已验收；v3 Capsule/Result **继承并扩展**它们，不替代。
- [B1] Capsule/Result 恢复完整既有字段，仅新增 `profile/policy/invocation/usage` 扩展。
- [B2] sandbox 拆为 `flagSupported/enforcementSupported/platform/evidence`；Windows 下不得宣称 tools/allow/deny 与 OS sandbox 等效；写入边界靠 worktree+锁+执行后 diff。
- [B3] raw stream 生命周期统一：仅在受限临时文件解析→归一化→**删除**；永久归档只存脱敏事件摘要 + usage 白名单数字。
- [B4] 删除读取/哈希 auth.json 方案；账号身份改由隔离子进程内官方 CLI 探测；探测不到记 `identityStatus: unknown`，不伪装分账。
- [B5] 命令规划器锁定固定 native 调用合同（见 G2）。
- [B6] failover 只允许"首请求前切换"或"控制器基于最后可验证点生成 continuation"；capsule 需白名单备用 profile；禁止静默换号。
- [S1] 路径 Windows 规范化 + 大小写无关 containment + junction/reparse/symlink 检查 + 拒绝默认 .grok 及危险父子路径。
- [S2] `allowedFiles` 加执行后 changed-files 硬校验（Windows 下的权威写入边界）。
- [S3] 锁算法定义 glob 重叠规则；陈旧锁用 PID+进程启动时间+lease/heartbeat 防 PID 重用。
- [S4] ledger 原子写入、崩溃可恢复；同键数字不一致**硬失败**，不静默去重。（原去重键 `profileIdentity+…` 已被 C2→D1 取代为 invocation 级 `profileId+sessionId+requestId`。）
- [S5] `end.usage` 命名为"本次调用服务端返回用量"，不等同官方额度；网页快照须验证浏览器账号↔profile 身份绑定。
- [S6] 新增 G9：跨项目分发门（安装位置/PATH shim/`doctor`/`version`/新账号隔离 OAuth onboarding）。

---

## 0. 目标与非目标
**目标**：①统一入口 `grok-worker run --profile <alias> --task <capsule>`；②调用方零底层暴露；③按 profile 分账、官方额度与本地消耗分层不混算。
**非目标**：不做能力评测；只管 Grok，不做跨服务商统一账本；不做猜测式对账；不存/不复制/不读取凭证。

---

## 1. 全局不变量（红线）
- **INV-1｜零凭证**：registry/ledger 永不写入 token/apiKey/auth 内容。**不读取、不哈希 auth.json**（B4）。
- **INV-2｜账号隔离**：每 profile 独立 `GROK_HOME`，必须在 `approvedProfileRoot` 下，禁止默认 `.grok`。老账号亦须隔离 profile。
- **INV-3｜usage 数字白名单，raw 不永久化**：raw streaming-json 仅在**受限临时文件**解析→归一化→**删除**；永久归档只存脱敏事件摘要 + usage/modelUsage/配额**数字白名单字段**。任何位置不得永久保存 raw 事件全文（B3，消解 v2 INV-3↔G3 矛盾）。
- **INV-4｜调用方零底层暴露**：调用方只提交 Capsule。**生产调用方代码**不得出现 `grok.cmd/GROK_HOME/auth.json/leader.sock/--permission-mode/--no-plan/--output-format` 字面量（provider 源码/tests/docs/fixtures/历史 runtime 只读证据豁免）。
- **INV-5｜身份为归属快照，非主键**：每次 run 落账的**分账主键是不可变 `profileId`(UUID)**；账号 identity（email 等）来自隔离子进程 CLI 探测，仅作**归属快照**，探测不到记 `identityStatus: unknown`，不得伪装分账，也**不作数据库键**（C2/B4）。
- **INV-6｜N 次调用可分辨**：去重键 `profileId + sessionId + requestId`（profileId 恒稳定，unknown 身份不影响键）；同键**数字不一致则硬失败**（数据完整性错误），不静默去重（C2/S4）。
- **INV-7｜写隔离靠预防控制，changed-files 只作检测**：Windows 无 OS sandbox enforcement。**写隔离**（预防）= `workspace-write` 强制 exclusive-worktree + 执行前 baseCommit 干净基线校验 + provider 生成 Edit/Write 路径 deny + Grok Worker Bash 恒 denied。**changed-files 校验是越界检测与失败判据、非预防性 sandbox**（拦不住先改后恢复/写 ignored/写仓库外），必须覆盖 tracked/untracked/ignored（C4/B2/S2）。

---

## 2. 契约定义（G0 交付）

### 2.1 `profiles.json`
路径：`%USERPROFILE%\AppData\Local\GrokUI\worker-profiles\profiles.json`
```jsonc
{
  "schemaVersion": 3,
  "approvedProfileRoot": "%USERPROFILE%\\AppData\\Local\\GrokUI\\codex-grok-workers",
  "allowedWorkspaceRoots": ["<legacy-consumer-root>", "<other-project-root>"], // 经 G9 roots register 登记，非硬编码示例
  "profiles": [{
    "profileId": "550e8400-e29b-41d4-a716-446655440000", // 不可变 UUID，分账主键（C2）
    "alias": "example-account",
    "grokHome": "C:\\...\\codex-grok-workers\\example-account", // ∈ approvedProfileRoot，非默认 .grok
    "executable": "%USERPROFILE%\\.grok\\bin\\grok.exe",
    "accountLabel": "operator@example.com",     // 展示用，非分账权威
    "authReadiness": { "oauthReady": true, "verifiedAt": "ISO8601" }, // 唯一 oauth 状态来源（E3）
    "identity": {                               // 归属快照，非主键、非阻塞（INV-5/C3）
      "identityStatus": "verified|unknown|unverified",
      "source": "cli_probe",                    // 隔离子进程内官方 CLI 探测；CLI 未给稳定 ID 则 unknown
      "value": "operator@example.com",           // unknown 时为 null
      "capturedAt": "ISO8601", "providerVersion": "1.0.0"
    },
    "sandboxCapability": {                       // B2：区分参数与强制
      "flagSupported": true,                    // grok.exe 接受 --sandbox
      "enforcementSupported": false,            // 本机 Windows：无 OS enforcement
      "platform": "windows",
      "evidence": "~/.grok/docs/user-guide/18-sandbox.md Platform Support: Linux/macOS only"
    },
    "modelSnapshot": { "models": ["grok-4.5"], "checkedAt": "ISO8601" }
  }]
}
```
**禁止**：token/apiKey/secret/auth 原文/auth 哈希。

### 2.2 `task-capsule.json`（**独立 Provider v3 schema**，复用既有 `$defs`）
现有 `tools/codex-grok-bridge/schemas/task-capsule.schema.json` 为 `additionalProperties:false`，**不能用 allOf 硬加字段**。做法（C6）：新建 `schemas/task-capsule.provider.v3.schema.json`，**完整复用既有 16 必填字段与 `$defs`定义、显式列出下方扩展字段、保持旧 schema 不变**。
既有 16 必填（不得倒退）：`taskId, stage, objective, baseCommit, workspace, worktree, allowedFiles, forbiddenActions, acceptanceCommands, contextRefs, realRequestPermission(allowed|denied), serviceControlPermission(allowed|denied), gitPermission, grokSessionId, resumePolicy, explicitStop`（可选 `model/reasoning/speed`）。
**provider 扩展字段**：
```jsonc
{
  "profile": "example-account",          // 只给 alias
  "policy": {                          // 声明式，不含 flag/raw tools
    "access": "readonly|workspace-write", // workspace-write 强制 exclusive-worktree（C4）
    "bash": "denied",                  // 仅 denied|controller-only（D3）；controller-only=控制器另行执行，命令绝不进 Grok argv/toolset
    "agents": "denied",                // 首版 schema 仅接受 denied（F3）
    "mcp": "denied", "web": "denied"   // 首版 schema 仅接受 denied（F3）；未来开放走具体 allowlist，不设宽泛 allowed
  },
  "failover": {                        // B6：显式白名单，禁止静默换号
    "allowedFallbackProfiles": [],     // 空=不许 failover
    "mode": "pre-first-request-only|controller-continuation",
    "switchPermission": "denied"       // denied|allowed
  }
}
```
调用方不得出现 flag 字面量 / raw `--tools` / GROK_HOME / executable / leader-socket。

### 2.3 `command-plan.json`（provider 生成，dryRun 导出）
记录固定 native 调用合同（见 G2）的完整 argv + 子进程 env + session 映射，供确定性审计。

### 2.4 `result-capsule.json`（**独立 Provider v3 schema**，复用既有 `$defs`）
同 §2.2 做法（C6）：新建 `schemas/result-capsule.provider.v3.schema.json`，完整复用既有字段与 `$defs`，旧 schema 不变。保留既有：`status, grokSessionId, baseCommit, changedFiles, commands, tests, findings, assumptions, unresolved, residualRisks, commitEvidence, diffEvidence, boundaryCompliance, taskId, stage, worktree, exitCode, redaction`。
**扩展**：`profileId, invocationId, requestId, variant, stopReason, durationMs`；`boundaryCompliance` 含 `changedFilesFinalState` + `policyAuditEvents`（INV-7/C4/D4）；`commands[].executedBy: worker|controller`（控制器执行的 `acceptanceCommands` 须标 controller，防 Worker 虚报测试，E6）；`redaction.rawStreamDeleted=true`，`rawCleanupFailed=true` 时 status 硬 FAIL（INV-3/C5）。

### 2.5 `usage-ledger.json`
```jsonc
{
  "taskId": "...",                      // 顶层只留 task 信息（D1）：failover 后一个 task 可跨多 profile
  "invocations": [{
    "invocationId":"...", "sessionId":"...", "requestId":"...", "variant":"main|resume|audit-fix|...",
    "profileId": "550e8400-...",        // 归属在 invocation 级（D1）
    "profileAlias": "example-account",
    "accountIdentitySnapshot": { "identityStatus":"verified|unknown","value":"...","capturedAt":"...","providerVersion":"..." },
    "runUsage": {                       // 命名：本次调用服务端返回用量，≠官方账号额度（S5）
      "present": true,
      "input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"total_tokens":0,
      "modelUsage": { "grok-4.5-build": { "modelCalls": 0 } }
    },
    "quotaSignal": { "present": false, "usedPercent": null, "source": "end_event" }
  }],
  "dedupKey": "invocation.profileId+sessionId+requestId",   // D1/C2/S4；同键数字冲突→硬失败
  "layers": {
    "sumRunUsage": { "total_tokens":0, "byType":{"input":0,"cache_read":0,"output":0,"reasoning":0}, "invocationsCounted":0, "invocationsUnknown":0 },
    "byProfileId": { "550e8400-...": { "total_tokens":0, "invocationsCounted":0 } }, // D1：failover 前后各归各账
    "profileUsageSnapshotRefs": {   // E2：按 profileId 联结全局快照库，failover 后可表达双账号各自额度
      "550e8400-...": { "store": "usage/profiles/550e8400-.../snapshots.jsonl", "latestCapturedAt": null, "accountBinding": null }
    },
    "localEstimate": { "present": false, "note": "replay_suspected", "value": null }
  }
}
```
**写入**：原子（temp→fsync→rename）、崩溃可恢复（S4）。`sumRunUsage`（本地可信量）与 `localEstimate`（replay 推算）不得混层、不得相加。

---

## 3. 门禁 G0–G9

### G0 — 契约与校验器
- **验收**：[ ] Provider v3 schema **完整复用既有 16 必填 + `$defs`**、旧 schema 不变（C6）；[ ] 缺任一既有必填即拒（防倒退）；[ ] 非法样例（含 token / grokHome 非法 / workspace 越界 / perm="plan" / identity 含 auth hash / 缺 profileId）全拒；[ ] 数字字段白名单归一器有单测。
- **路径安全负向验收（C7/S1）**：[ ] 拒绝并覆盖测试：junction/reparse point、含 `..` 的逃逸、大小写变体绕过、默认 `.grok` 及其危险父/子目录、UNC 路径、device path（`\\.\`、`\\?\`）；containment 判定须 Windows 规范化 + 大小写无关。

### G1 — Profile 注册表 + 身份探测
- **验收**：[ ] `example-account` 隔离注册，grokHome ∈ approvedProfileRoot 非默认 .grok；[ ] **老账号只建空 home、oauthReady=false，禁复制默认 auth，启用须隔离 home 内官方 OAuth**；[ ] **身份由隔离子进程 CLI 探测**，探测不到记 `identityStatus:unknown`，无 auth.json 读取/哈希（INV-1/INV-5/B4）；[ ] `sandboxCapability` 四字段据实写入，Windows 下 `enforcementSupported=false`（B2）。

### G2 — 命令规划器（两段式 + headless 审批 + 执行语义 · B5/C1/D2/D3/D5）
- **拆分（C1）**：
  - `planTemplate`：确定性、**逐字节可比**——固定合同项：native `grok.exe`；`--no-plan`；`--no-memory`；`--output-format streaming-json`；`--prompt-file`（路径占位符）；`--cwd`（占位符）；`--disallowed-tools run_terminal_cmd`（D3）；默认 `--no-subagents`（agents=denied 时另加 `--disallowed-tools Agent`）；子进程级 env `GROK_HOME<user-home>/LOCALAPPDATA` 指向隔离 profile；tools/allow/deny 映射。
  - `materializedInvocationPlan`：运行态唯一字段——**独立 leader socket（每 run 唯一）**、invocationId、临时 prompt 实路径、时间戳、new/resume 与 session registry 映射（依 capsule.resumePolicy/grokSessionId）——**只校验结构与唯一性，不做逐字节比对**。
- **权限拒绝模型（D2/E1，文档核实：项目 `.claude/settings*.json` 会被合并、项目 allow 参与；PreToolUse fail-open）**：
  - **主闸 = `dontAsk` + deny 恒胜**：隔离 HOME 生成 `.claude/settings.json`，`permissions.defaultMode="dontAsk"`（无 allow 即拒）；deny 规则**永久封死** `.git/** .grok/** .claude/** ` 与 Provider runtime（`deny>ask>allow`，任何来源 allow 都翻不了）；allow 仅覆盖 Capsule 允许的 Edit/Write/Read 路径；`contextRefs` 编译为**只读** allow（E5）。
  - **folder-trust default-deny（F1，纠正 v6 反转）**：folder-trust **保持启用**，隔离 profile 用**空的 Provider 托管 trust store**（项目默认未受信→项目 hooks/MCP/LSP 静默跳过）；**永不传 `--trust`**；run 前确认目标项目不在 trusted-folders；隔离 config 设 `[compat.claude] hooks=false`、`[compat.cursor] hooks=false`；禁加载非 Provider 插件。**绝不设 `GROK_FOLDER_TRUST=0`**（那是拆门）。
  - **preflight + 生效配置验证（E1/F1/F2）**：扫描项目 `.grok/config.toml`+`.grok/hooks/**`+`.claude/settings*.json`（向上到仓库根）+MCP/LSP，**含 permission-allow/hook/MCP/plugin/folder-trust 的配置一律硬失败**（不得仅凭 hash 放行；hash allowlist 仅限不影响权限的普通配置，F2）；用 `grok inspect --json` 只读验证**最终生效**配置，发现未授权 hook/MCP/plugin/permission 来源即禁止 materialize/run。
  - **PreToolUse = 审计 + 第二道防线**（非主闸，因 fail-open）：记 `policyAuditEvents`；即便 hook 超时/崩溃 fail-open，越界写仍由 dontAsk+deny 拒。
- **执行语义（D5）**：`grok-worker plan --profile … --task …` **永不 spawn**；`grok-worker run` 仅接受 `realRequestPermission=allowed`，`denied` spawn 前硬失败；`serviceControlPermission/gitPermission/forbiddenActions` 编译进工具过滤 + permission rules（deny）+ PreToolUse 审计。每次 run 校验 `model/reasoning` 仍在最新 capability snapshot 内，不靠旧缓存（E7）。
- **验收**：[ ] `planTemplate` 逐字节一致；`materializedInvocationPlan` 结构合法且 socket/invocationId 唯一；[ ] 固定合同项（`--disallowed-tools run_terminal_cmd`、`--no-subagents`）缺一即 FAIL；**断言 argv/env 中无 `--trust`、无 `GROK_FOLDER_TRUST=0`**（F1）；[ ] settings.json 含 `defaultMode:"dontAsk"`、allow 仅 Capsule 路径、deny 含 `.git/.grok/.claude/runtime`、`[compat.claude/cursor] hooks=false`；隔离 trust store 为空且目标项目未受信（F1）；[ ] **mutation：允许路径能写、越界路径被拒**；[ ] **项目提权负向夹具**：项目 `.claude/settings.json` 注入 `allow:["*"]` / `.grok/hooks/**` 提权 / MCP 注入，均被 **preflight 硬失败**（permission-bearing 配置不得 hash 放行，F2）或 dontAsk+deny 压制；[ ] `grok inspect --json` 验证生效配置无未授权 hook/MCP/plugin/permission 来源（F1）；[ ] **hook fail-open mutation**：PreToolUse hook 超时/崩溃时越界写**仍被拒**（E1）；[ ] `plan` 零 spawn、`run` 对 `denied` spawn 前硬失败；四权限字段各配删-enforcement-必失败 mutation（D5）；[ ] Windows 下 plan 不把 `--sandbox` 当边界依据（B2）；[ ] golden 快照对 `planTemplate` 通过。

### G3 — 执行器 + raw stream 生命周期 + 写隔离/越界检测
- **raw 生命周期（C5）**：优先**流式内存解析不落盘**；若必须落 temp 则：受限 ACL、`finally` 删除、Provider 启动时清理孤儿 raw 文件、清理失败在 Result Capsule 硬 FAIL 告警（`rawCleanupFailed=true`）。
- **写隔离（预防 · C4）**：`workspace-write` 强制 **exclusive-worktree**；执行前校验 baseCommit 且 worktree 干净基线；Edit/Write 路径 deny 由 provider 生成；Grok Worker Bash 恒 denied。
- **越界证据两层（D4，v4"事后 diff 发现仓库外/先改后恢复"的要求不可实现，作废）**：
  - `changedFilesFinalState`：worktree 内 tracked/untracked/ignored 的**最终状态**证据，须 ⊆ allowedFiles；
  - `policyAuditEvents`：PreToolUse guard 记录的**执行前拒绝**事件（仓库外写、越界写、先改后恢复类尝试在此层拦截并留痕）。
- **验收**：[ ] 只读 canary 跑通；[ ] raw 归一化后不残留，永久只留脱敏摘要+usage 数字，`redaction.rawStreamDeleted=true`（INV-3）；[ ] **崩溃负向夹具**：timeout/kill/断电模拟后无孤儿 raw 残留或被启动清理清除，清理失败硬告警（C5）；[ ] `changedFilesFinalState` 覆盖 tracked/untracked/ignored，越界即 result FAIL（INV-7）；[ ] **"写仓库外/先改后恢复"夹具验证调用在执行前被 PreToolUse 拒并记入 `policyAuditEvents`**，不要求 Git 事后发现（D4）；[ ] 同 taskId resume 产生第 2 条 invocation 不覆盖（INV-6）。

### G4 — Usage Ledger + 查询接口
- **验收**：[ ] 去重键取 **invocation 级** `profileId+sessionId+requestId`（D1；unknown 身份不破键），**同键数字冲突硬失败**（C2/S4）；[ ] ≥3 invocation 时 sumRunUsage 正确、四分项保留；[ ] **`byProfileId` 聚合正确**：构造跨 profile failover 的 task，两段消耗各归各 profile（D1）；[ ] **红线**：redaction 后 usage 数字仍在、raw 已删（INV-3）；[ ] 截断 run→present=false 计 unknown 不猜；[ ] ledger 原子写、崩溃可恢复；[ ] 查询 `grok-worker usage show --profile/--task`、`usage export --format json`；[ ] `runUsage` 文案标注"本次调用服务端返回用量，≠官方额度"（S5）。

### G5 — 并发与双重锁（S3）
- **验收**：[ ] profile 锁（GROK_HOME）+ workspace/file 所有权锁；[ ] 跨 profile 写同一文件集→被 file 锁串行；文件互斥→并行；[ ] 锁冲突按 **glob 重叠规则**判定；[ ] 陈旧锁用 **PID+进程启动时间+lease/heartbeat** 判定，防 PID 重用误清；[ ] 崩溃后可自愈不死锁。

### G6 — 额度感知与**安全** Failover（B6）
- **验收**：[ ] 读 end 事件配额信号，耗尽产出 `profile_exhausted`；[ ] **仅**在"首请求前切换"或"控制器基于最后可验证点生成 continuation invocation"两种模式下切换，且 capsule.failover 已白名单该备用 profile、switchPermission=allowed；[ ] **禁止**对已部分改文件的 run 静默重跑换号（防重复施工/session 错配/重复计费）；[ ] 切换后 ledger identity 记为备用账号（INV-5）；[ ] 无配额信号不臆造耗尽。

### G7 — 官方用量快照（按 profile 存储 + 账号绑定 · S5/C3/E2）
- **验收**：[ ] `grok-worker usage-snapshot --profile <alias>` 授权时抓 Grok 网页额度，写**全局 `usage/profiles/<profileId>/snapshots.jsonl`**（E2）；[ ] `source/capturedAt/accountBinding` 绑定到该 profileId；浏览器账号↔profile 不匹配记 `mismatch`、无法绑定记 `unbound/unsupported`，均不伪造、不阻塞（C3）；[ ] Task 查询按 invocation.profileId 联结，**failover 后能分别展示两账号各自快照**（E2）；[ ] 与 sumRunUsage 物理隔离、无求和路径。

### G8 — 迁移与切换
- **验收**：[ ] 代表性存量任务经 grok-worker 跑通、产品结果与旧路径一致（diff）；[ ] **生产调用方代码** grep 无底层字面量（provider/tests/docs/fixtures/历史 runtime 豁免）；[ ] 老/新账号分账清晰、identity 快照正确。

### G9 — 跨项目分发与 onboarding（S6 · C3/E4）
- **验收**：[ ] 全局安装位置 + PATH/shim，任意项目 `grok-worker` 可直接调用；[ ] `grok-worker roots {list|register|inspect}` 管理 `allowedWorkspaceRoots`（E4，非硬编码）；[ ] `grok-worker doctor`（自检：profiles/能力/锁/ledger 完整性）与 `grok-worker version`；[ ] 新账号 onboarding 可跑通：空 home→官方 OAuth→`authReadiness.oauthReady=true`（**独立可验**）；身份探测**能给稳定 ID 则 verified、给不了则 unknown/unverified 但仍用 profileId 正常分账**——**不以 verified 作为 onboarding 完成的强制条件**（C3）。

---

## 4. 验收夹具
补：`capsule.missing-required-stage.json`、`capsule.invalid-raw-tools.json`、`capsule.invalid-bash-patterns.json`（验 allowed-with-patterns 已删）、`profiles.missing-profileId.json`、`profiles.invalid-auth-hash-identity.json`、`profiles.windows-sandbox-noenforce.json`、`paths.negative/`（junction/reparse、`..`、大小写变体、默认 `.grok` 父子、UNC、device path）、`project-config.malicious/`（项目 `.claude/settings.json` 注入 `allow:["*"]` / `.grok/hooks/**` 提权 / MCP 注入，permission-bearing 配置须 preflight 硬失败、不得 hash 放行）、`trusted-folders.leak/`（目标项目预置于 trust store 或误传 `--trust`，须被拒/告警）、`hook.fail-open/`（PreToolUse 超时/崩溃后越界写仍被拒）、`pretooluse.mutation/`（允许路径可写、越界被拒；四个权限字段各一个删-enforcement-必失败用例）、`stream.with-body-content.jsonl`、`stream.crash-orphan/`、`stream.multi-invocation/`（含 1 对同键异值 requestId 验硬失败）、`ledger.cross-profile-failover/`（验 byProfileId 各归各账）、`changed-files.final-state/`（tracked/untracked/ignored 越界各一例）、`ledger.golden.json`。

## 5. 总 DoD
- [ ] G0–G9 全勾选；INV-1~INV-7 均可自动化证明。
- [ ] 端到端 run→result-capsule(含 boundaryCompliance changed-files 校验)+usage-ledger；`usage show` 三层可见。
- [ ] Capsule/Result 继承既有 schema 无字段倒退（B1）。
- [ ] 永久堵死：redaction 不吞 usage 且 raw 不永久化、崩溃不残留孤儿（B3/C5）；多 invocation 按 invocation 级 `profileId+sessionId+requestId` 硬键去重、同键异值硬失败、跨 profile failover 各归各账（D1/C2/S4）；**写隔离主闸=dontAsk+deny 恒胜(封死 .git/.grok/.claude/runtime)+preflight 硬失败项目权限配置+folder-trust 保持启用且空 trust store(永不 --trust、绝不 GROK_FOLDER_TRUST=0)+grok inspect --json 验生效配置**，PreToolUse 仅审计/第二防线（fail-open 仍被拒）、`changedFilesFinalState` 仅作最终状态证据（E1/F1/F2/D2/D4/INV-7）；Worker Bash 仅 denied|controller-only、`run_terminal_cmd` 显式 disallow、subagent/MCP/web 默认拒、项目配置不可扩权（D3/E1）；官方快照按 profileId 存储、failover 双账号各自可见（E2）；plan 永不 spawn、run 门禁于 `realRequestPermission`、权限字段全有 enforcement mutation（D5）；无静默换号（B6）；无 auth.json 读取/哈希（B4）；identity unknown 不阻塞、不伪造（C3）。

## 6. 施工顺序
```
G0─▶G1─▶G2─▶G3─▶G4─▶G5
                 ├─▶G6  ├─▶G7  ├─▶G9
                 └─▶G8（依赖 G1–G7）
```
关键路径 **G0→G4**（契约到分账）；G3 的 raw-stream 生命周期与 changed-files 边界校验是 Windows 安全兜底的核心，不得后置。
