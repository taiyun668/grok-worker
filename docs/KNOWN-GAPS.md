# 已知缺口

公开时就知道、但当时决定不修的东西。列在这里是为了：新来的人不必重新发现，
而且能看出哪些是「没做」、哪些是「决定这样」。

---

## doctor 不检查 Grok CLI 是否安装

`grok-worker doctor` 的十项检查全部针对本 provider 自己的目录结构
（`registry-v3`、`ledger-root`、`lock-root`、`availability-root` 等），
**没有任何一项确认 Grok CLI 存在**。

后果：一台完全没装 Grok CLI 的机器上，`doctor` 照样返回 `pass: true`。
问题会推迟到 `onboard` 或 `run` 才暴露，而那时的报错来自底层，
不会告诉人「你还没装 Grok CLI」。

**当前的处理是文档警告** —— README 的「开始之前」和 `skill/SKILL.md` 的
「Before the first delegation on a new machine」都写明了这一点。

**这是拿文档补代码的缺口，而文档是最容易被跳过的东西。**
正确的修法是给 `doctor` 加一项 `grok-cli-present` 检查，让它在最早的时刻
就说清楚。公开后作为第一个 issue 处理。

---

## 跨平台未经验证

在 Windows 上开发和验证。入口是 `.cmd` shim，文档示例是 PowerShell。
`package.json` 声明 `node >= 18`，但 macOS / Linux **没有跑过**。

不要假设可用，也不要在任何地方声称支持。

---

## 不提供文件系统写隔离

工具提供凭据隔离与独立 `GROK_HOME`，**这不等于写隔离**。
并发写任务需要调用方自己保证独占工作区或不重叠的文件所有权。

这是设计取舍，不是待办 —— 但容易被误解成安全保证，所以写在这里。
