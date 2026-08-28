# 已知缺口

公开时就知道、但当时决定不修的东西。列在这里是为了：新来的人不必重新发现，
而且能看出哪些是「没做」、哪些是「决定这样」。

---

## doctor 的外部依赖语义

`doctor` 现在包含只读检查 `grok-cli-present`，不会派生 Grok 进程，也不会消耗额度。
锁检查会用 pid + 创建时间探测持有者状态，可能对本机做进程查询；那不是 Grok 请求。
为兼容现有调用方，`pass` 仍只表示 provider 自身是否健康；`providerHealthy`
显式表达同一语义，`grokCliAvailable` 表示 CLI 文件是否存在，`readyForRun`
只有在两者都为真时才为真。阻塞锁列入 `lockInspection`，不单独把 `pass` 打成 false。

---

## 跨平台未经验证

在 Windows 上开发和验证。入口是 `.cmd` shim，文档示例是 PowerShell。
`package.json` 声明 `node >= 22`，但 macOS / Linux **没有跑过**。

不要假设可用，也不要在任何地方声称支持。

---

## 锁的失败关闭与人工恢复

`acquireLock` 只在持有者被证明 `dead`（`ESRCH` 或 pid 复用且创建时间不匹配）
时自动回收。`unverifiable`、损坏 JSON、无效 heartbeat/lease 元数据、以及租约
过期但进程仍存活的锁都会保留，后续冲突任务得到 `LOCK_CONFLICT`。

这是刻意的失败关闭，不是遗漏。操作者出口：

- `grok-worker doctor` 与 `grok-worker locks inspect` 只读列出 lock ID、scope、
  年龄、owner 状态和 reason
- `grok-worker locks cleanup --id <lockId> --confirm <lockId>` 按精确 ID 清理
- 已证明 `live` 的锁拒绝清理；检查到删除之间文件被替换则失败并写审计

没有「清掉所有过期锁」的批量命令。

---

## 不提供文件系统写隔离

工具提供凭据隔离与独立 `GROK_HOME`，**这不等于写隔离**。
并发写任务需要调用方自己保证独占工作区或不重叠的文件所有权。

这是设计取舍，不是待办 —— 但容易被误解成安全保证，所以写在这里。
