# grok-worker

`grok-worker` is a local command-line provider that lets other AI agents invoke Grok CLI as a governed worker. It replaces manual account switching and ad hoc delegation with isolated account homes, policy-constrained task capsules, multi-account selection, and auditable run results. It requires a separately installed Grok CLI and Node.js 22+, is currently verified only on Windows, schedules only `grok-4.6`, and does not provide filesystem write isolation or official quota data.

Full documentation is in Chinese below.

[Full English documentation](README.en.md) · [English quick start](docs/QUICKSTART.en.md)

把 Grok CLI 变成一个**可以被别的 AI 代理安全调用**的 worker：多账号轮换、
每个账号一份隔离的家目录、按策略约束模型与权限、每次运行留下可复核的凭证。

零运行时依赖，只需要 Node ≥ 22。

---

## 它解决什么问题

同时用多个 AI 编程 CLI 的人都会撞上同一件事：**账号、额度、隔离和调度全靠人脑管**。

具体到 Grok：

- **多个账号之间切换**要手动登录登出，而登出会影响所有用它的地方
- **两个任务同时跑**会共用同一份凭据目录，互相踩踏
- **让另一个 AI 代理去调用 Grok** 时，没有任何东西阻止它选错模型、
  改错文件、或者把凭据打印到日志里
- **跑完之后**说不清这次到底用了哪个账号、哪个模型、改了什么

`grok-worker` 把这些收进一个命令行工具：每个账号是一个 profile、
一份独立的 `GROK_HOME`，任务以 capsule 形式声明，跑完产出结果凭证。

---

## 开始之前

这个工具**驱动 Grok CLI，但不包含它**。开始之前你需要：

1. **装好 Grok CLI** —— `npm i -g @xai-official/grok`，然后 `grok --version` 能跑通
2. **至少一个 Grok 账号** —— 多账号才有轮换的意义，但一个也能用
3. **Node ≥ 22**

> `grok-worker doctor` 会只读检查 Grok CLI 是否存在，不会执行 Grok 命令。
> `pass` 保留为 provider 自身健康状态；真正执行前请看 `readyForRun`。

## 装

```powershell
git clone https://github.com/taiyun668/grok-worker.git
cd grok-worker
node bin/grok-worker.js deploy pointer --write
```

`deploy pointer --write` 会在 `%USERPROFILE%\.local\bin\` 放一个稳定的 shim，
之后直接用 `grok-worker` 即可。不带 `--write` 时只做演练，不改任何东西。

## 第一次用：先把账号接进来

装完之后 `grok-worker profiles list` 会是空的 —— 这是正常的，还没有任何账号。
**必须先 onboard 一个，否则后面每一步都没有 profile 可用。**

```powershell
grok-worker profiles list                       # 空的
grok-worker onboard --profile my-account        # 别名自己起，比如 work / personal
grok-worker profiles probe --profile my-account # 探测这个账号能用哪些模型
grok-worker profiles list                       # 现在能看到它了
```

`onboard` 会为这个账号准备一份**独立的 `GROK_HOME`**，登录走 Grok 自己的流程。
每多一个账号就多跑一次 `onboard`，别名不同即可。

`probe` 之后要确认输出里含 `grok-4.6` —— 这是当前唯一会被调度的模型。
没有的话说明这个账号还用不了，换一个或等账号开通。

---

## 最短可用流程

```powershell
grok-worker doctor                              # 环境自检（含锁的只读列表）
grok-worker locks inspect                       # 只读列出锁 ID / scope / 年龄 / owner 状态
grok-worker profiles list                       # 看有哪些账号
grok-worker onboard --profile <alias>           # 接入一个账号（走 Grok 自己的登录）
grok-worker profiles probe --profile <alias>    # 探测这个账号能用哪些模型

grok-worker task init --profile <alias> `
  --workspace <project-root> `
  --objective "<要做什么>" `
  --out task.json --real allowed                # 生成任务 capsule

grok-worker plan --profile <alias> --task task.json   # 零请求的安全检查
grok-worker run  --profile <alias> --task task.json   # 真正执行
```

`plan` **不发任何请求、不消耗额度** —— 它只检查这个任务能不能安全地跑。
先 plan 再 run 是这个工具的基本用法。

`doctor` 和 `locks inspect` 会列出阻塞锁的 lock ID、scope、年龄、owner 状态
和 reason，但不会自动删除。清理必须精确确认：

```powershell
grok-worker locks cleanup --id <lockId> --confirm <lockId>
```

已证明 `live` 的锁会被拒绝删除。检查与删除之间若锁文件被替换，清理会因
竞争失败并留下审计记录。

---

## 配套的 skill

`skill/` 目录下是一份给 AI 代理用的操作规程（Codex / Claude Code 的 skill 格式）。

**没有它，别人拿到的只是一堆命令，不知道该按什么顺序、在什么约束下用。**
它规定的是：

- 永远不直接调 `grok.cmd` / `grok.exe`
- 永远不读取、复制、打印凭据文件
- 写任务必须有独占工作区 —— 隔离的 `GROK_HOME` **不等于**写隔离
- `plan` 是零请求安全检查，不能当成一次真实运行
- 额度归属只做本地记账，查不到就是 `unknown`，不冒充官方数字

装法：把 `skill/` 复制到你的代理的 skills 目录
（Codex 是 `~/.codex/skills/grok-worker-pool`，Claude Code 是 `~/.claude/skills/`）。

---

## 设计取向

**判据要有反向用例。** 「不匹配失败串」不等于「成功」—— 判不出来就报未知，
不默认成功。这条在实践中挡下过不止一次误判。

**隔离要能被证伪。** 每加一个隔离维度都要有「这一维没设对时必须失败」的用例，
否则测试可能恰好命中唯一被满足的那一维。

**进程身份要成对。** 凡按 pid 操作进程，必须同时校验进程创建时间 ——
pid 会被操作系统回收，只认 pid 会误伤无关进程。

**锁要失败关闭。** 判不出持有者就保留锁，不静默夺锁。生产路径只回收已经
证明 `dead` 的锁；损坏 JSON、`unverifiable`、无效租约元数据、以及租约过期
但进程仍存活的锁都只报告。清理必须指定精确 lock ID，并 `--confirm` 同一个 ID。

---

## 边界与限制

诚实列出现在**不**支持或**没验过**的：

- **平台**：在 Windows 上开发和验证。入口是 `.cmd` shim，文档示例是 PowerShell。
  macOS / Linux **未经验证**，不要假设可用。
- **模型**：当前只调度 `grok-4.6`。这是 skill 里的硬约束，不是限制的疏漏。
- **额度**：不获取官方额度数字。本地按 profileId 归属，查不到就是 `unknown`。
- **写隔离**：工具提供凭据与家目录隔离，**不提供文件系统写隔离** ——
  并发写任务需要调用方自己保证独占工作区或不重叠的文件所有权。

---

## 测试

```powershell
npm ci
npm run quality
```

`quality` 会执行 lint、针对新拆分模块的 JavaScript 类型检查、完整零请求测试、
公共卫生检查和覆盖率门槛。另有 `npm run test:mutation` / `test:global` /
`test:availability` / `test:run-recovery` 等独立套件，见 `package.json`。

---

## 仓库里有什么

```
bin/         入口
lib/         provider 实现
schemas/     capsule 与配置的 schema
tests/       测试套件
fixtures/    测试夹具
skill/       给 AI 代理用的操作规程
docs/        内部验收与独立审计记录
```

`docs/` 是施工过程中的验收记录和审计报告，**读者不必读** ——
保留它们是因为它们记录了每条约束是被什么事故换来的。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
