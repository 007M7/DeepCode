# Agent Note: source-guard 拒绝直接编辑 staging 检出目录

Status: implemented

[English](2026-07-28-source-guard-staging-edit-gate.md) | 中文

## Problem

[`dsh-customize`](../../../../skills/dsh-customize/SKILL.md) skill（技能）规范对 dsh 源码检出的每项个人变更：先在从 staging 分支顶端分出的任务 worktree 中实现，再于 `.agents/merge.lock` 保护下完成集成。它的核心规则是一条禁令：不得直接编辑个人 staging 检出目录；而若只通过提示词文本传达禁令，它恰好会在最要紧的场景中失效。从未加载该 skill 的 agent（智能体）根本看不到规则；即便尽早加载，也仍可能在三十次工具调用后将其忘掉。这种失败既静默又代价高昂：提交会落在启动器实际运行的 staging 分支上，不属于任何任务分支，既未持有锁，也没有用于回滚的 worktree。

提示词指导无法解决这个问题，因为未被阅读的正是这些指导。该规则需要一个强制执行点。

## Decision

`@deepseek-ai/dsh-source-guard`（`packages/guard/source-guard/`）是一个 `tools/pre-execute` 监听器；它会返回 `{kind: 'deny', reason}`，拒绝目标解析到受保护 staging worktree 内的 `write` 或 `edit`，除非调用会话的持久日志已经记录过一次成功的 `skill` 调用，且名称为 `dsh-customize`。它不注册服务，也不贡献提示词文本或工具 schema；获准的调用与未加载该插件时的调用没有区别。任何已交付的默认组合都不包含它。

### 从文件而非路径前缀或 `git` 判定 Git 身份

系统通过读取 `.git`、其中的 `gitdir:` 指针以及 `HEAD` 来判断路径是否受保护。它可以解析三种形态：普通克隆（`.git` 是目录，且自身就是共享目录）、链接 worktree（`.git` 是文件，指向 `<common>/worktrees/<name>`，其共享目录位于上两级）以及 HEAD 分离状态（`HEAD` 保存原始对象 id，不指向任何分支）。`gitdir:` 指针无论是绝对路径（`git worktree add` 写入的形式）还是相对路径都可以解析；Git 会以包含该指针的 worktree 目录为基准解析相对路径。

只有目标的 worktree 在两项身份上都与启动器的 worktree 匹配时才会拒绝：共用同一个共享 Git 目录，且分支相同。这两项身份均通过解析 `protectedCheckout` 得出，因此无需配置受保护分支的任何信息。较早版本则匹配 `dsh-staging/*` 名称模式；现已改用确切分支规则，因为模式会在两个方向上出错。它会拒绝旧安装留下的每一个同级 staging worktree，尽管其中没有任何一个运行着启动器；对于 staging 分支不遵循任何命名约定的维护者，它又会静默地完全不提供保护——而已交付的默认配置必须在 [`scripts/install.sh`](../../../../scripts/install.sh) 未创建的检出目录上也能生效，这一属性是致命的。

路径前缀规则不仅不精确，而且本身就是错误的。该 skill 规定的任务 worktree 位于受保护树*内部*的 `<staging>/.worktrees/...`，因此前缀规则会拒绝工作流要求的每一次编辑。解析过程从目标向外逐层查找，遇到第一个所属 worktree 时停止，因此返回最内层的 worktree：嵌套的任务 worktree 会返回自身的任务分支并获准，而启动器自身所在的树会返回启动器的分支并被拒绝。

有两个路径细节决定门禁究竟能否生效，二者都是强制执行要求，而非细节润色。仓库身份会按解析符号链接后的路径进行比较（使用 `dsh-sandbox` 的 `canonicalPath`），因为位于 `/var/...` 下的会话 cwd 和位于 `/private/var/...` 下的配置路径在 macOS 上是同一个目录，若按路径字符串比较，每次写入都会故障放行（fail-open）。此外，相对 `file_path` 会完全按照 `dsh-tool-fs` 的方式，相对于调用会话的工作区解析；若只判断绝对路径，相对路径就会成为绕过门禁访问受保护文件的路径。

`protectedCheckout` 指定受保护检出目录内的一条路径，默认值为本模块自身的文件。由此解析出运行中 harness 的启动来源检出目录——当前运行的部署，无论其分支采用什么名称。若 harness 从已安装副本运行，解析出的会是另一个仓库或没有仓库，因此不会保护任何内容；该规则在源码检出之外没有意义。

已交付的 TUI 组合会以这些默认值加载插件，因此每个源码安装无需配置即可受到保护。对于普通项目，它不会生效：若工作区位于其他仓库中，或不存在工作区，就绝不会匹配启动器的身份。

### 从持久日志回放满足状态

如果日志中存在一条 `tool/call`，它调用名为 `skill` 的工具，参数可解析为 `{name: <requiredSkill>}`，且按调用 id 能配对到非错误的 `tool/result`，门禁即解除。二者都已持久化（`packages/core/session/src/types.ts`），因此无需新增会话事件，也不与 skill 提供方内部实现耦合。

日志是唯一状态。在内存中记录满足状态（`WeakMap` 结构，[`repeat-tool-guard`](../../archived/feature/2026-07-08-repeat-tool-guard.md) 将其用于调用链）所需实现会更小，但恢复后满足状态会丢失：一个已经读取过该 skill 的恢复会话会被要求再次读取，而这次拒绝看起来会像缺陷而不是规则。回放的代价是扫描日志，但首次命中即停止，并换来恢复行为正确。

### 刻意采用故障放行

目标路径不在任何 worktree 内、HEAD 分离、属于其他仓库、`gitdir:` 指针格式错误或元数据不可读时，调用都会交给调用链的其余部分处理。反过来，只要无法判定 Git 身份就拒绝，会让任何 `.git` 权限问题都导致 harness 完全无法写文件。该 guard 旨在防止一种特定且可恢复的错误，不得造成比该错误更严重的故障。

### 范围收窄

`read` 从不受门禁限制：检查 staging 不会违反任何规则，而且该 skill 明确允许只读提问。`bash` 同样不受门禁限制。要可靠判定哪些 shell 命令会修改状态，需要构造一个无法给出可信完备标准的匹配器，因此执意修改的模型仍可通过 shell 修改 staging。这是一道防止遗忘的边界，不是阻止刻意操作的沙箱。

## Alternatives considered

- **用建议性提醒代替拒绝**（使用 `additionalContexts`，挂载在 `tools/post-execute` 上，采用 `repeat-tool-guard` 的形态）。不予采纳：提醒到达时写入已经发生，违规已成事实，而指导又一次沦为纯文本。
- **将 `{kind: 'ask'}` 交给审批。** 不予采纳：在常见场景中，它会对任务 worktree 内每次合法编辑都发起询问；在没有审批支持的组合中还会退化为拒绝，使行为取决于无关插件。
- **运行 `git rev-parse`，并通过 `ctx.subprocess` 执行。** 对替代方案进行实测后不予采纳：读取两个文件即可回答同一问题，每次受门禁限制的写入都无需 spawn 进程，不要求 `git` 存在于 `PATH` 中，也不依赖子进程。读取 `.git` 与 `HEAD` 所依据的是稳定的磁盘格式，而非实现细节。
- **显式配置 `protectedRoots`，不做检测。** 不予采纳：这会让常见场景的保护效果依赖配置正确性，而陈旧的绝对路径会静默禁用保护。
- **可配置的 staging 分支名称模式**（`stagingBranchPatterns`，默认 `dsh-staging/*`）。最初随产品交付，随后删除：它从两个方向划错了保护范围——既纳入每个不运行启动器的陈旧同级 worktree，又完全不保护分支另有名称的维护者。由启动器派生分支无需配置，也不可能配置错误。
- **自动检测检出目录，不提供覆盖项。** 不予采纳：检测只是默认行为，而非不可更改的规定；若部署要保护另一个检出目录，或自身从已安装副本运行，就需要显式值。
- **拒绝检出根目录下的一切操作，包括 `.worktrees/`。** 不予采纳：这会阻断该 skill 规定的工作流，让 guard 在每次合法任务编辑时触发。
- **用修改类命令匹配器把守 `bash`。** 推迟而非否决：如果实际观察到绕过行为，值得重新考虑。任一方向判断错误的匹配器，都不如如实限定范围的门禁。

## Consequences

如今，该规则无需依赖模型已经读过它也能生效；拒绝理由会列出路径、分支与 skill，让模型的下一步操作明确，无需猜测。强制执行位于拥有该决策的操作边界，因此提示词过滤或监听器顺序都无法绕过它。

将其纳入 TUI 默认组合意味着每个源码安装无需配置即可受到保护；由于分支是派生而非按名称指定，保护会在升级时跟随启动器。这种覆盖范围的代价是插件会为每位用户加载，包括工作区永远不可能匹配启动器身份的用户。

除此之外的代价是：guard 的完整程度受限于其工具列表，`bash` 仍保持开放。worktree 身份在插件生命周期内按目录缓存，因此无法观察到任一侧在会话中途切换分支。只保护启动器自身的检出目录，因此陈旧的同级检出目录仍可编辑。加载该 skill 会为整个会话解除门禁，却不会验证工作流是否确实得到遵循——门禁只能证明指令已被阅读，不能证明已被执行。满足状态按会话隔离，因此拥有独立会话的 subagent 必须自行加载该 skill。

## Testing

单元测试套件基于真实 Git 元数据 fixture（测试前置数据），使用 mock 适配器驱动真实 agent loop（智能体循环）：覆盖一个 staging worktree、嵌套其中的任务 worktree、普通克隆、位于 staging 命名分支上的其他仓库、HEAD 分离状态、绝对和相对 `gitdir:` 指针、指向同一仓库的符号链接路径、格式错误的指针以及不可读元数据，使两个源码文件都达到逐文件 100% 覆盖率。配套的 `invariant.ts` 会验证持久拒绝的结构，因为拒绝文本是该包唯一面向模型的输出，且只有其中列出路径、分支和 skill 时才具有可操作性。

真实组合冒烟测试通过 Loader 与 headless 应用启动 `examples/headless-agent/tests/fixtures/guard/source-guard/cordis.yml`，并对组装后的运行断言三项事实：工具结果是错误、文本与拒绝理由逐字一致、目标文件仍保留原始字节。这证明系统在分发前强制执行规则，而不是事后给出建议。

一个 ACP（Agent Client Protocol）快照场景（`source-guard-staging-deny`）最初负责组装后的 transcript（文本记录），通过新的 `Scenario.prepareCwd` 钩子在 harness 生成的 cwd 中植入 staging worktree——Git 永远不会跟踪名为 `.git` 的条目，且 `.gitignore` 会排除所有 `worktrees/` 目录，因此 fixture 提交两个 `HEAD` 的内容，由钩子组装真实布局。编写它立刻证明了投入的价值：它暴露了上述两个路径缺陷（transcript 显示每当 guard 悄然不作判断时 `fs-policy` 都会率先响应），随后又发现了自身首版 fixture 的问题——被忽略的 `worktrees/` 路径因未跟踪文件而在本地通过。该场景后来被移除，组装运行证据合并进 Loader 组合冒烟测试；它引入的 `prepareCwd` 钩子仍留在快照 harness 中，服务于仓库形态的 fixture。

## Related

- [个人 staging 维护 skill 的 Agent Note](../process/2026-07-23-personal-staging-maintenance-skills.md)：本门禁负责执行该工作流的一条规则。对方 Agent Note 负责这些 skill 的内容与发现机制；本文只负责强制执行点，对工作流本身不具有定义权。
- [拦截 seam Agent Note](2026-06-30-interception-seams.md)：本门禁拒绝时使用的 `tools/pre-execute` `allow`/`deny`/`ask` 词汇。
- [repeat-tool-guard Agent Note](../../archived/feature/2026-07-08-repeat-tool-guard.md)：同类 guard；本文刻意不采用其建议性形态。
