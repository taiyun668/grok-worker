# "彻底剥离 Grok UI" 完成验收标准（独立审计定义）

> 背景：Provider 已从 `D:\Grok UI\.codex\grok-bridge\provider` 剥离到独立仓库 `D:\Grok Worker Provider`。剥离进行中，仓库当前处于多分支、无主线、旧 dataRoot 残留的迁移中途态。本文件把"彻底剥离完成"从一句话变成**可过/不过的门**，供 Codex 收口、Owner 验收、独立审计复核。
> 独立审计已确认的既有事实（作为基线，不重复）：v6-r8 早重置已实现并部署、在跑；部署 commit `f377250`（`codex/availability-v6-r8-finalfix` HEAD）、`sourceDirty:false`、release filesSha256 `94e383deba44d26e2b68137c2ab6b50ad18fb673b5751dd210fa3395e8db14aa`；autoProbe 真实探针已由 Owner 授权。
> 定稿日期：2026-07-22

## 验收原则
- 每条给"验证命令 + PASS 条件"，Codex 执行、Owner 核、审计复核三方对同一命令。
- 现在（迁移中途）不做终判；Codex 报"剥离完成"后照本文件逐条复核，全 PASS 才算收口。
- 遵循坑库 P-114：done ≠ verified，Codex 声明不等于验收通过。

## S-1 代码来源可追 + 主线收口
剥离后"权威源码仓"必须名副其实：clone/默认检出即在跑的代码，部署 commit 有主线归属和 tag。
```bash
cd "D:/Grok Worker Provider"
C=f377250e8355c1274abcfb6321fc036afc754543
git branch -a                                     # 目视：存在 main；无 codex/availability-v6-r8 / -complete / -repair 三个僵尸分支
# main 是否包含部署 commit（先判 main 存在，避免 fatal；用精确分支名匹配，勿用锚点正则）
git show-ref --verify --quiet refs/heads/main \
  && { git merge-base --is-ancestor $C main && echo "S1 PASS: main 含部署commit" || echo "S1 FAIL: main 不含 $C"; } \
  || echo "S1 FAIL: 无 main 分支"
git tag --contains $C          # PASS：非空，部署 commit 有 release tag
git rev-parse --abbrev-ref HEAD   # PASS：= main（不是 provider-v5）
# 僵尸分支已删校验：下面应为空
git branch --list 'codex/availability-v6-r8' 'codex/availability-v6-r8-complete' 'codex/availability-v6-r8-repair'
```
- **PASS 条件**：main 存在且 `git merge-base --is-ancestor $C main` 成立；`-finalfix` 已并入、3 个僵尸分支已删（最后一条输出为空）；部署 commit 有 tag；默认检出 = main。
- 注：`git branch --contains … | grep '^main$'` 这类锚点正则匹配不了 `git branch` 输出的前导标记/空格，会假报 FAIL，勿用；改用上面的 `merge-base --is-ancestor` 或 `--format='%(refname:short)'` 精确匹配。

## S-2 零 Grok UI **耦合**（不是零字符串出现）
目标是"无功能耦合/依赖"，不是"文本零出现"。**允许**：README/docs 里说明性提及（如"this is NOT a Grok UI product"）、历史任务卡里的护栏文字。**禁止**：代码/配置里活跃指向 Grok UI 路径、旧 dataRoot、grok-bridge 的**依赖或运行路径**。
```bash
cd "D:/Grok Worker Provider"
# 只查会影响运行的面：lib/ 代码、schemas、部署入口、config——排除 README/docs/历史任务卡
git grep -niE "grok[- ]ui|grok-bridge|GrokUI[\\/]+worker-(provider|profiles)" -- \
  'lib/**' 'schemas/**' 'bin/**' '*.cmd' '*.json' ':!package*.json' ':!docs/**' ':!README*' ':!.codex/**'
#   → PASS：空（运行面无 Grok UI 耦合）；若有命中，逐条判断是否真依赖
# 部署 release 的运行代码同样核
REL=$(node -e "console.log(require(process.env.LOCALAPPDATA+'/GrokWorkerProvider/current.json').releasePath)")
grep -rniE "grok[- ]ui|grok-bridge|GrokUI[\\/]+worker" "$REL/lib/" && echo "FAIL: 部署运行代码残留耦合" || echo "PASS: 部署无耦合"
```
- **PASS 条件**：`lib/schemas/bin/入口/config` 与部署 `lib/` 中，无对 Grok UI 路径、旧 `GrokUI\worker-*` dataRoot、grok-bridge 的**活跃依赖或运行路径引用**。README/docs/历史任务卡中的说明性/护栏性提及不计为 FAIL。
- 说明：早期版本此条误写成"字符串零出现"，实测会把 README 里"NOT a Grok UI product"这类**说明剥离的良性文本**判成 FAIL——已修正为只判运行面耦合。

## S-3 设计文档归位
8 份 r2-r8（含本文件）现为 untracked，剥离收口必须入库留证。
```bash
cd "D:/Grok Worker Provider"
git status --short docs/ | grep -E '^\?\? .*AVAILABILITY-LAYER|SEPARATION-COMPLETION'   # PASS：无输出（全部已提交）
```
- **PASS 条件**：`docs/AVAILABILITY-LAYER.v6-early-reset*.md` 与本验收文件均已提交进 main，无 untracked 设计文档遗留。

## S-4 部署可从主线重建（权威性硬验证）
"权威源码仓"的真义：能从主线某 tag 重新构建出与当前部署字节一致的 release。
```bash
cd "D:/Grok Worker Provider"
git checkout <release-tag>                         # S-1 打的 tag
# 用仓库既有发布流程/脚本构建到临时目录，再算 canonical filesSha256
# 对比部署 manifest：
node -e "console.log(require(process.env.LOCALAPPDATA+'/GrokWorkerProvider/releases/1.0.0-provider-root-separation-20260722-r2/release-manifest.json').filesSha256)"
# 期望重建结果 filesSha256 == 94e383deba44d26e2b68137c2ab6b50ad18fb673b5751dd210fa3395e8db14aa
```
- **PASS 条件**：从 tag 重建的 release `filesSha256` 与当前部署 manifest 完全一致（证明部署确从该源码可复现）。若发布流程尚无可复现构建入口，本条一并要求补上。
- **前提约束**：字节一致要求构建**确定性**——若 26 个 release 文件中有构建期变动内容（时间戳、机器名、生成序号等），必须将其排除出 `filesSha256` 覆盖面或固定其值，否则本条会因良性差异 FAIL。收口时需确认 release 全部文件都是源码直拷/确定性生成，无易变内容。

## S-5 单一 dataRoot 生效，旧数据清理/归档
剥离后只能有一套活跃 dataRoot/registry，旧的不得被误读。
```bash
node -e "const c=require(process.env.LOCALAPPDATA+'/GrokWorkerProvider/current.json');console.log('active dataRoot:',c.dataRoot,'\nregistry:',c.registryPath)"
# PASS：dataRoot/registry 均在 GrokWorkerProvider\ 下，不指向 GrokUI\
ls "$LOCALAPPDATA/GrokUI/worker-provider" 2>/dev/null && echo "旧 dataRoot 仍在（需清理或归档）" || echo "PASS：旧 dataRoot 已清理"
```
- **PASS 条件**：current.json 的 dataRoot/registryPath 均在新根下；旧 `GrokUI\worker-provider`（含旧 4 个 UUID profile 的 availability 历史）已清理或明确归档，不再有第二套并行 registry 可被误读。

## 复核安排
Codex 报"彻底剥离完成"后，由独立审计对 S-1…S-5 逐条跑上述命令；全 PASS → 剥离收口验收通过；任一 FAIL → 退回并附证据。本文件本身也在 S-3 的提交范围内。
