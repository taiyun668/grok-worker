# 公开准备评估

- 日期：2026-08-25
- 评估对象：`grok-worker-provider` v1.0.2，HEAD `dae93aa`
- 目的：判断是否具备作为公开仓库发布的条件（含 OpenAI Codex for OSS 申请）
- 性质：现状核查。逐条给出「查到什么」与「要做什么」，不含未经核实的推断。

---

## 一、结论

**具备条件，但有三件事必须先做，其中一件只有 Owner 能定。**

这个项目比同期的 GOGO PARTY 更适合先公开，原因见 §5。

---

## 二、已核实为干净的部分

| 项目 | 核查方式 | 结果 |
|---|---|---|
| 真实凭据泄露 | 全树 + 全历史 grep `sk-` / `xai-` / `ghp_` / JWT 形态 | ✅ 无。匹配到的全是测试夹具名（`sk-multi-attempt-402-failover` 一类） |
| 凭据文件被提交 | `git log --diff-filter=A` 找 `auth.json` / `.env` / `credential` | ✅ 无 |
| 第三方依赖 | `package.json` | ✅ **零运行时依赖**，只要求 Node ≥ 18 |
| 测试可跑 | `node tests/provider-harness.js` | ✅ 退出码 0 |

零依赖这一点在公开场景下是加分项：别人 clone 下来不需要装任何东西。

---

## 三、必须处理的三件事

### ① 没有 LICENSE —— 只有 Owner 能定

`package.json` 里连 `license` 字段都没有，仓库根也没有 LICENSE 文件。

**没有许可证的公开仓库，法律上别人不能用、不能改、不能分发**（默认版权全保留）。
OpenAI 的 OSS 计划也明确要求 OSI 认可的许可证。

GOGO PARTY 已定为 `AGPL-3.0-or-later`。这个项目可以一致，也可以不一致 ——
它是个 CLI 工具，如果希望被别的项目当依赖引入，MIT / Apache-2.0 阻力更小；
AGPL 会让不少公司内部禁止引入。**这是产品意图问题，不是技术问题。**

### ② 42 个提交全部带真实邮箱

```
Ayun <taiyun668@gmail.com>
```

公开即永久，改当前文件去不掉历史里的。三个选项：

1. **接受** —— 很多人本来就用真名真邮箱开源，这不算错
2. **新仓从空历史开始** —— 代价是丢掉那一个月的提交历史，
   而「持续维护」正是 OSS 计划评审看的三栏之一
3. **重写历史改作者** —— 会改变所有 commit 哈希；本项目没有像 GOGO PARTY
   那样的哈希绑定治理体系，所以技术上可行，但要确认没有外部引用依赖旧哈希

**倾向 1**：这个项目的提交历史本身是资产，为了隐藏一个公开邮箱而丢掉它不划算。
但这是 Owner 的隐私偏好，不该由别人替他决定。

### ③ README 是写给自己看的

现在的开头：

> This directory is the independent Provider v3 implementation governed by
> `../GROK-WORKER-PROVIDER.plan.md`. It does not use or modify `../runtime/**`.

引用了一个**仓库之外**的文件，对外来者没有意义。后面直接是命令清单，
没有回答「这是什么、解决什么问题、为什么要用它」。

要重写成：一句话说清是什么 → 解决什么问题 → 装 → 最短可用示例 → 边界与限制。

---

## 四、次要问题

### 文档里的本机路径 —— 已处理

评估当时：10 个文件含开发机的用户目录绝对路径，以及两处真实 Grok 账号标识
（一个 iCloud 邮箱、一个由它派生的 profile 别名）。都在 `docs/` 下的审计与
验收记录里，不在可执行代码里。

**已按 Owner 决定统一清理**：用户目录换成 `%USERPROFILE%`，账号标识换成
`operator@example.com` / `example-account`。作者身份（git 提交里的
`Ayun <taiyun668@gmail.com>`）按 Owner 意愿保留。

`.codex/` 目录（内部任务定义）已从版本控制移除并加入 `.gitignore`。

> 注意：清理只作用于当前树。那两处账号标识存在于初始提交 `2f9aa17` 中，
> 历史里仍可翻到。是否改写历史见 §六。

### 文档目录的定位

`docs/` 下 23 个文件多为内部审计与验收记录（`R8-BASELINE-EVIDENCE.md`、
`SEPARATION-COMPLETION-ACCEPTANCE.md`、`docs/audits/*`）。

对外来者是噪音，但**主动保留并说明它们是什么**，比删掉更有说服力 ——
一个能拿出独立审计记录的项目，比只有 README 的项目更像真东西。
建议在 README 里用一句话交代 `docs/` 是内部验收记录，读者不必读。

---

## 五、为什么它比 GOGO PARTY 更适合先公开

| | grok-worker | GOGO PARTY |
|---|---|---|
| 形态 | CLI 工具，`npm i -g` 装完即用 | 带界面的本地产品，需装 Node + 三家 CLI + 走引导 |
| 依赖 | 零运行时依赖 | 多个 |
| 提交历史 | 42 个，横跨 2026-07-21 → 08-20，一个月 | 产品部分集中在最近几天 |
| 边界完整性 | 单一职责，说得清 | 核心主张（多项目）目前是禁用按钮 |
| 平台 | 待确认 | 仅 Windows 验过 |

OSS 计划评审看三样：**meaningful usage、broad adoption、active maintenance**。
其中「active maintenance」grok-worker 现在就填得上，GOGO PARTY 填不上。

---

## 六、建议的顺序

```
1. Owner 定许可证（唯一的阻塞项）
2. Owner 定邮箱怎么处理（接受 / 新仓 / 改写）
3. 重写 README
4. 决定本机路径是否替换（可选）
5. 建公开仓
```

前两条只有 Owner 能定，后面的可以代做。

---

## 七、这次评估没有做的事

- **没有跑全部测试套件**，只跑了 `provider-harness.js`（退出码 0）。
  另外 8 个 `test:*` 脚本没跑。
- **没有审查代码质量或安全性**，只做了公开前的泄露与合规核查。
- **没有验证跨平台**。`package.json` 声明 `node >= 18`，但入口是
  `grok-worker.cmd`，README 用的是 PowerShell 示例 —— 实际是否支持
  macOS / Linux 未经核实，不要在 README 里声称支持。
