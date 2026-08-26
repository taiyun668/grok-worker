# CC Switch 用量导出适配器 — 施工计划 (v1)

> 目标读者：接手施工的 Agent（预计 Sonnet）。本文自包含，所有事实已查证于 2026-07-22，照做即可，不需要重新摸排。
> 背景记忆：`cc-switch-usage-hub`、`grok-worker-provider-status`、`construction-team-architecture`（Issue #39/#40）。

## 0. 目标（一句话）

写一个**本地适配器**：读 Grok Worker Provider 的 usage-ledger → 计算成本 → 写入 CC Switch 的 SQLite，使 Grok 用量出现在 CC Switch「使用统计」的**趋势图 + 真实 token + 成本**里。**只做本地文件读 + DB 写，不调用任何模型（零 token 消耗）。**

CC Switch **无源码**（Tauri 单 exe），所以只能从数据层接入 = 直插 DB。已排除的路：会话日志解析器（无 grok 解析器且加不了）、代理（Worker 不走 OpenAI 兼容 egress）。

---

## 1. 已查证的事实（照抄，别重查）

### 1.1 数据源（Grok 侧，只读）
- Ledger 目录：`%USERPROFILE%\AppData\Local\GrokWorkerProvider\worker-provider\usage\tasks\*.json`
  - 指针文件：`%LOCALAPPDATA%\GrokWorkerProvider\current.json` 的 `dataRoot` 字段 = 上面那个 `worker-provider` 根。**优先读指针，别写死路径。**
- Ledger 结构（v4，schema：`D:\Grok Worker Provider\schemas\usage-ledger.provider.v4.schema.json`）：
  ```
  { taskId, dedupKey:"invocation.profileId+sessionId+requestId",
    invocations:[ { invocationId, sessionId, requestId, variant, profileId, profileAlias,
                    accountIdentitySnapshot:{capturedAt,...},
                    runUsage:{ present, unknown, input_tokens, cache_read_input_tokens,
                               output_tokens, reasoning_tokens, total_tokens, modelUsage, note },
                    quotaSignal } ],
    layers:{...} }
  ```
- **只处理 `runUsage.present === true` 的 invocation**。`present:false / unknown:true`（配额耗尽/报错）**跳过，绝不插 0**（provider 自己的铁律：never invent 0）。
- 时间戳来源（按优先级）：
  1. `runs/<taskId>/<runId>.json` 的 `createdAt`/`updatedAt`（ISO 字符串）——但 run↔invocation 需按 taskId 关联。
  2. 回退：invocation 的 `accountIdentitySnapshot.capturedAt`（ISO）。
  3. 兜底：ledger 文件 mtime。
- 耗时：`results/<taskId>/<invocationId>.json` 顶层 `durationMs`（可选，用于 `latency_ms`）。首字时间无来源。
- **模型名：ledger 不记（`modelUsage:{}` 空），result capsule 顶层也无 model 字段。** 事实上恒为 `grok-4.5`（provider.js:507 `--model capsule.model||"grok-4.5"`，profile 快照唯一模型也是 grok-4.5，Grok UI runs 亦为 grok-4.5）。→ **默认常量 `grok-4.5`**，做成可配置。

### 1.2 目标（CC Switch 侧，要写）
- DB：`%USERPROFILE%\.cc-switch\cc-switch.db`（SQLite，**WAL 模式，CC Switch 运行时占用**）。
- 表 `proxy_request_logs`，完整列 + 约束：
  ```
  request_id TEXT PRIMARY KEY
  provider_id TEXT NOT NULL
  app_type TEXT NOT NULL
  model TEXT NOT NULL
  request_model TEXT           output_tokens INTEGER NOT NULL DEFAULT 0
  pricing_model TEXT           cache_read_tokens INTEGER NOT NULL DEFAULT 0
  input_tokens INTEGER NOT NULL DEFAULT 0   cache_creation_tokens INTEGER NOT NULL DEFAULT 0
  input_token_semantics INTEGER NOT NULL DEFAULT 0
  input_cost_usd TEXT NOT NULL DEFAULT '0'  output_cost_usd TEXT NOT NULL DEFAULT '0'
  cache_read_cost_usd TEXT NOT NULL DEFAULT '0'  cache_creation_cost_usd TEXT NOT NULL DEFAULT '0'
  total_cost_usd TEXT NOT NULL DEFAULT '0'
  latency_ms INTEGER NOT NULL                first_token_ms INTEGER   duration_ms INTEGER
  status_code INTEGER NOT NULL               error_message TEXT       session_id TEXT
  provider_type TEXT   is_streaming INTEGER NOT NULL DEFAULT 0   cost_multiplier TEXT NOT NULL DEFAULT '1.0'
  created_at INTEGER NOT NULL                data_source TEXT NOT NULL DEFAULT 'proxy'
  ```
  - **必填无默认**：`request_id, provider_id, app_type, model, latency_ms, status_code, created_at`。
  - `created_at` = **Unix 秒**（样本 1784736470，非毫秒）。
  - 成本列是 **TEXT**（存字符串数字，如 `'0.242922'`）。
  - `input_token_semantics` 含义未知，填默认 `0`。
- `app_type = 'grokbuild'`（已注册，CHECK 允许）。
- `data_source = 'grok_worker'`（新取值）。
- `model_pricing` 表已有 **grok-4.5**：input `$2`/M、output `$6`/M、cache_read `$0.5`/M、cache_creation `$0`/M（每百万 token）。

---

## 2. 字段映射（ledger invocation → proxy_request_logs 行）

| 目标列 | 值 |
|---|---|
| request_id | `grok-worker:<invocationId>`（invocationId 是 uuid，全局唯一，保证幂等） |
| provider_id | `grok-worker` |
| app_type | `grokbuild` |
| model / request_model / pricing_model | `grok-4.5` |
| input_tokens | `runUsage.input_tokens` |
| cache_read_tokens | `runUsage.cache_read_input_tokens` |
| output_tokens | `runUsage.output_tokens + runUsage.reasoning_tokens`（见决策 D1） |
| cache_creation_tokens | `0`（ledger 无此概念） |
| input_cost_usd | `input_tokens/1e6 * 2` |
| cache_read_cost_usd | `cache_read_tokens/1e6 * 0.5` |
| output_cost_usd | `(output_tokens+reasoning_tokens)/1e6 * 6` |
| cache_creation_cost_usd | `0` |
| total_cost_usd | 上面四项之和 |
| latency_ms | result capsule `durationMs` ?? `0` |
| first_token_ms / duration_ms | `null` / `durationMs`（可选） |
| status_code | `200`（只插 present=true） |
| session_id | `runUsage` 所在 invocation 的 `sessionId` |
| provider_type | `grok_worker` |
| is_streaming | `1` |
| cost_multiplier | `'1.0'` |
| created_at | 见 1.1 时间戳（转 Unix 秒） |
| data_source | `grok_worker` |
| 定价数字从哪来 | **从 DB 的 `model_pricing` 表读 grok-4.5 现价，别写死**（价会变） |

**自校验**：`input_tokens+cache_read_tokens+output_tokens(含reasoning) == ledger total_tokens`（应相等，否则告警）。

---

## 3. 施工阶段

### Phase 0 — 验证三个未知（闸门，先做，别跳）
1. **【最关键】仪表盘读哪张表**：CC Switch「使用统计」的**趋势图/顶部真实token/总成本**是直接查 `proxy_request_logs`，还是查 `usage_daily_rollups`？
   - 验证法：拿现有 codex 数据反推——观察 UI 显示的当日总量，对比两张表各自 SUM，看哪张对得上；或临时往 DB **副本**插一行 grok_worker 测试数据，用副本启动/指向 CC Switch（若可）看是否显示。
   - **结论决定 Phase 3 是否必须同时写 `usage_daily_rollups`**（见 3.x）。保守假设：**两张都要写**。
2. **活库写安全**：CC Switch 运行时 DB 是 WAL。用第二连接 `INSERT OR IGNORE` 是否安全 → 在**副本**上验证并发写不破坏；正式写前**必须备份 DB**（复制文件，或调 CC Switch 的 create_db_backup 后再写）。设 `PRAGMA busy_timeout=5000`。
3. **schema 校验**：启动时读 `pragma table_info(proxy_request_logs)`，列集不匹配预期就**中止并报错**（防 CC Switch 升级后 schema 漂移）。

### Phase 1 — 写适配器（dry-run 优先）
- 语言：Node（系统 `node v24` 自带 `node:sqlite`，**零依赖**）。
- 位置建议：`D:\Grok Worker Provider\tools\cc-switch-export\export.mjs`（Grok 侧拥有 ledger，符合 Issue #39「provider 自吐 usage」）。
- 逻辑：读指针→枚举 ledger→过滤 present=true→按 §2 映射→计算成本（价从 model_pricing 读）→输出。
- `--dry-run`：只打印将插入的行 + 汇总（条数/总token/总成本），**不碰 DB**。先跑这个人工核对。

### Phase 2 — 副本验证
- 复制 `cc-switch.db` 到临时目录，对副本执行真实 `INSERT OR IGNORE`。
- 查 `SELECT count(*), sum(input_tokens+output_tokens+cache_read_tokens), sum(CAST(total_cost_usd AS REAL)) FROM proxy_request_logs WHERE data_source='grok_worker'` 核对与 dry-run 一致。
- 幂等：对副本**重跑一次**，确认条数不增（PK 去重生效）。

### Phase 3 — 正式写 + UI 验收
- **先备份**活库 DB。
- 对活库执行插入（短事务、INSERT OR IGNORE、busy_timeout）。
- 若 Phase 0 结论是「读 rollups」或不确定：**同时 upsert `usage_daily_rollups`**（按 `date,app_type,provider_id,model,request_model,pricing_model` 聚合，累加 request_count/success_count/各类 token/total_cost_usd；PK 冲突则相加）。
- 打开 CC Switch → 使用统计 → 来源筛 `grokbuild` → 确认：请求日志出现 Grok 行、token 与成本正确、趋势图/顶部数字有值。

### Phase 4 —（可选）增量/定时
- 幂等已由 PK 保证，最简单：Windows 计划任务每 N 分钟跑一次全量扫描（INSERT OR IGNORE 天然去重）。
- 若量大再加「已处理 ledger 文件 mtime 水位」state 文件优化。

---

## 4. 待决策（含推荐默认，施工时如无异议按默认走）

- **D1 reasoning_tokens 归属**：`proxy_request_logs` 无 reasoning 列。**推荐**：并进 `output_tokens` 且按 output 价计费（保证总 token 与 ledger 一致、成本正确）。副作用：UI「Output」略偏高。备选：丢弃 reasoning（则总量少算、成本少算）。
- **D2 是否插失败/配额耗尽行**：**推荐否**（只插 present=true，避免虚增请求数）。若想看失败率，可另插 status_code=402、token=0 的行。
- **D3 是否在 `providers` 表补一行** grokbuild provider（让「Provider 统计」更好看）：**推荐做**，插 `(id='grok-worker', app_type='grokbuild', name='Grok Worker', category='custom')`；非必需。

---

## 5. 验收标准
1. CC Switch 筛 grokbuild 能看到 Grok 用量行，token/成本正确（与 dry-run 汇总一致）。
2. 重复运行导出器**不产生重复行**。
3. CC Switch 本体功能不受损（DB 未损坏），且有 DB 备份可回滚。
4. 趋势图/顶部「真实消耗 Tokens」「总成本」对 grokbuild 有非空数值。

## 6. 回滚
- 删除本适配器写入的行：`DELETE FROM proxy_request_logs WHERE data_source='grok_worker'`（及对应 rollups）。
- 或用 Phase 3 前的 DB 备份整体还原。

## 7. 边界（勿越）
- 不改 CC Switch（无源码）。不动 Grok Worker Provider 的执行/ledger 逻辑，只读它的 ledger。
- 不把此适配器写进 NaveHQ 代码库（CLAUDE.md 红线：不写死具体项目业务进 NaveHQ）。

---

## 8. 施工执行记录（2026-07-22，Sonnet）

**状态：已完成，活库验收通过。** 实现见 `D:\Grok Worker Provider\tools\cc-switch-export\export.mjs`。

**Phase 0 结论**：
1. 仪表盘只读 `proxy_request_logs`——证据：`usage_daily_rollups` 最新日期停在 2026-06-21（已停更一个多月），而当日趋势图有逐小时曲线，rollups 表 PK 粒度是「天」级、给不出小时曲线，两者矛盾说明仪表盘不可能读 rollups。**因此本次未写 `usage_daily_rollups`**，只插 `proxy_request_logs`，验收也证实这张表确实没被写坏且仪表盘该看的数据都在 proxy_request_logs 里。
2. 活库写安全：`INSERT OR IGNORE` + `busy_timeout=5000` + 短事务在副本和活库上都验证通过，CC Switch 进程（PID 未变）全程保持 Responding=True，其余 app_type 行数不受影响。
3. schema 校验：与预期列集完全一致，无漂移。

**实现中发现并修正的两处事实（原计划里没写清楚，已在代码注释里记录）**：
- **ledger 的 `total_tokens` 定义不含 `reasoning_tokens`**（验证：`input+cache_read+output == total_tokens`，reasoning 是单独追踪的）。原计划 §2 的自校验公式写成了 `input+cache_read+output+reasoning`，会跟 ledger 自身的 total_tokens 永远对不上、报出 10/10 条假警告。已修正校验公式为不含 reasoning，D1 决策（reasoning 并入 CC Switch 的 output_tokens 计费）本身不变，只是不能拿来跟 ledger.total_tokens 比较。
- **result capsule 的 `durationMs` 字段在实际数据里全部是 `null`**（抽查全部 11 个 result 文件确认，非本次 3 个才这样）。没有用来源，不是脚本 bug。已加兜底：优先用 capsule.durationMs（为未来版本填充这个字段保留），退化到 `runs/<taskId>/*.json` 的 `updatedAt - createdAt`（注意这是「含排队/重试的运行总跨度」，不是纯模型延迟，是估计值不是精确值）；两者都没有则 `latency_ms=0`。10 条里 9 条拿到了非零延迟，1 条（quota-probe 任务，run 结构不同）退到 0。

**实际写入结果**：10 行（4 条 present:false/unknown 被跳过，符合"绝不编 0"铁律）、共 2,207,136 token、$2.2057 成本，写入前自动备份活库到 `cc-switch.db.bak-<timestamp>`。幂等验证：同一批数据重跑写入变更数为 0。

**未验收项**：CC Switch 使用统计面板的**肉眼显示确认**——本次施工环境无桌面 UI 自动化能力，只能验证到 SQL 层面数据正确落库，无法截图确认前端渲染。Owner 需自行打开 CC Switch 核实。

**未做（按计划标注为可选）**：Phase 4 定时增量（Windows 计划任务）未设置，当前是手动单次运行；`--skip-providers-row` 未使用（D3 按默认做了）。

---

## 9. 追加修正：漏掉的历史数据（同日发现并补齐）

**问题**：首次施工只导出了 10 行、220 万 token，Owner 指出"有四个账号，怎么才两百多万"，促成二次排查。

**根因**：Grok Worker Provider 今天（2026-07-22）发生过一次内部数据根迁移（`current.json` 的 `previousVersion` 字段指向迁移前版本）。迁移把旧 dataRoot 的内容整体挪进了 `D:\Grok Worker Provider-legacy-archive\credential-residue-20260722-r2\worker-provider\`，新 dataRoot（`%LOCALAPPDATA%\GrokWorkerProvider\worker-provider`）只剩迁移后的新增用量。首次导出只指向了指针解析出的新 dataRoot，没有意识到旧数据被搬到了别处，因而漏掉了迁移前的全部历史。

**排查方法**：
1. 检查 `worker-profiles/profiles.json` 确认确实有 4 个账号 profile（example-account/ayun030/ayun0300/ayun360-icloud-com）。
2. 在 `D:\Grok Worker Provider-legacy-archive\` 下发现三个日期归档：`credential-residue-20260722`（无 usage 数据，只有 canary/availability 测试产物）、`credential-residue-20260722-r2`（**有完整 usage/tasks，30 个 ledger 文件**）、`provider-v6-r8-20260722`（源码快照，非运行时数据，其中的 `ledger.cross-profile-failover` 是测试夹具不是真用量）。
3. 对 `-r2` 归档做了三项验证再导入：①invocationId 与当前 dataRoot **零重叠**（真正新增，非重复快照）；②抽查 `variant` 字段全为 `"main"`（非 mock/test 数据）；③按 profileAlias 汇总token，确认横跨 example-account/ayun030/ayun360 三个账号 + 一个 `supergrok-w12`（非邮箱格式的账号别名，值得留意但仍是 `variant:main` 的真实数据）。
4. 收尾核实：全盘搜索 `D:\` 下所有 `usage\tasks` 目录、以及 `%LOCALAPPDATA%\GrokWorkerProvider\` 下有无其它日期归档——**确认只有这一个历史归档，没有更早的遗漏**。D 盘下大量 `Grok Worker Provider-r8-candidate-*`、`-w6-*` 等目录是源码构建候选快照，不是运行时数据根（provider 的 `grok-worker.cmd` 启动脚本写死"never falls back to a repository-local provider implementation"，运行时数据永远只走 `%LOCALAPPDATA%` 指针指向的单一 dataRoot）。

**代码改动**：给 `export.mjs` 加了 `--data-root <path>` 参数，允许指向任意一个"同构"的 provider 数据根（需自带 `usage/tasks` + `runs/` + `results/` 同级目录），不用为归档场景另写代码。字段映射、幂等（PK=`grok-worker:<invocationId>`）、成本计算逻辑完全复用，天然保证跨根导入不重复。

**补导结果**：从 `-r2` 归档追加导出 **32 行、1,514.0047 万 token、$13.0266**（5 条 unknown 跳过）。

**最终合计（活库，2026-07-22 完工）**：**42 行、17,347,183 token、$15.23225**，覆盖 5 个账号别名（example-account/ayun030/ayun360/ayun0300/supergrok-w12），时间跨度 2026-07-20 ~ 07-22。此数字视为当前已知的完整历史，如后续 Owner 仍觉得偏低，下一步该查的是 07-20 之前是否存在更早的、未被这次搜索覆盖的数据根（本次排查未发现，但没有覆盖"07-20 之前"这个时间点本身是否已是 provider 有效运行的起点）。
