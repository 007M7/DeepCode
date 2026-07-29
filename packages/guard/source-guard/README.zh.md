# @deepseek-ai/dsh-source-guard

[English](README.md) | 中文

这是一道强制执行门禁，而非面向模型的工具：它不会出现在工具列表中，只增加一种行为。若 `write` 或 `edit` 的目标位于运行中 harness 启动来源的 dsh 检出目录内，并处于该检出目录自身的分支上，它会拒绝调用，直到调用方会话的持久日志表明已成功加载 `dsh-customize` skill（技能）。该 skill 要求在任务 worktree 中实现个人变更，并在 staging 锁保护下完成集成；本插件把其核心规则（「不要直接编辑个人 staging 检出目录」）从提示词指导变成一道模型无法因遗忘而越过的边界。

## 配置

```yaml
- id: source-guard
  name: '@deepseek-ai/dsh-source-guard'
  config:
    requiredSkill: dsh-customize          # default; the skill whose load lifts the denial
    tools: [write, edit]                  # default; the gated tool names
    protectedCheckout: /path/to/checkout  # defaults to this module's own location
```

插件加载时，每个字段都会对错误配置快速失败：`tools` 为空列表、`requiredSkill` 为空白字符串，或 `protectedCheckout` 使用相对路径时，都会抛出错误，绝不静默回退。

`protectedCheckout` 指定位于待保护检出目录内的一条路径；其 worktree 会提供两项受保护身份：仓库和确切分支。其默认值是本模块自己的文件，由此解析出运行中 harness 启动来源的检出目录——当前运行的部署，无论其分支采用什么名称。分支既无需配置，也不会通过模式匹配，因此 staging 分支不遵循任何命名约定的维护者同样会受到保护。若 harness 从已安装副本运行，则会解析到另一个仓库，或根本解析不到仓库，因此不会保护任何内容；这条规则在源码检出目录之外没有意义。

已交付的 TUI 组合（`apps/cli/base.cordis.yml`）会以默认配置加载本插件。若用户的工作区并非启动器自身所在的检出目录，本插件不会生效，因此普通项目不会发生任何变化。

## 受保护的路径

保护范围根据从文件读取的 Git 身份确定，即 `.git`、其中的 `gitdir:` 指针和 `HEAD`；既不按路径前缀判断，也不运行 `git`。此处若匹配路径前缀就会出错：skill 要求使用的任务 worktree 位于 staging 树*内部*的 `<staging>/.worktrees/...`，而这正是应该进行编辑的位置。

解析过程从目标路径开始向外逐层查找，遇到第一个所属 worktree 就停止，因此返回最内层的 worktree。只有该 worktree 在两项身份上都与启动器的 worktree 匹配，才会拒绝：共用同一个共享 Git 目录，且分支相同。嵌套在受保护树下的任务 worktree 会返回自己的任务分支并获准；启动器自身所在的树会返回启动器的分支并被拒绝。仓库身份会按解析符号链接后的路径进行比较，因此指向同一仓库的两条路径——macOS 上位于 `/var/...` 下的会话 cwd 和位于 `/private/var/...` 下的配置路径——会相互匹配，而不会触发故障放行（fail-open）。

要求匹配确切分支而非名称模式，可确保门禁仅作用于当前运行的部署。先前安装留下的陈旧同级检出目录虽然共享仓库，却没有运行启动器，因此该工作流规则不适用于它，它仍可编辑。

`gitdir:` 指针既可以是绝对路径（`git worktree add` 写入的形式），也可以是相对路径；Git 会以包含该指针的 worktree 目录为基准解析相对路径，本插件对两者都能解析。相对 `file_path` 会像文件系统工具一样，相对于调用会话的工作区解析，因此不会成为绕过门禁访问受保护文件的路径。

门禁刻意保持较窄的范围：

- **`read` 从不受门禁限制。** 检查 staging 检出不构成违规，因此只有修改类工具是候选项。
- **`bash` 不受门禁限制。** 可靠识别会修改内容的 shell 命令不在范围内，因此执意修改的模型仍可通过 shell 修改 staging。
- **没有 agent（智能体）的调用会被放行。** 直接调用 `ctx.tools.execute()` 的调用方没有可供回放的会话，也没有需要纠正的模型。
- **无法解析 Git 状态时故障放行。** 不属于任何 worktree 的路径、任一侧的 HEAD 分离状态、其他仓库或分支、格式错误的 `.git` 指针或不可读的元数据，都会把调用交给链中后续环节处理。若每逢 Git 身份不可用就阻止所有写入，这道门禁造成的危害将大于它所防止的违规。
- **无法解析的目标不会被判断。** `file_path` 为空、不是字符串，或它是相对路径而会话未指定工作区时，调用会交给工具自身校验。

插件会在其整个生命周期内按目标目录缓存 worktree 身份，因此同一目录中的重复写入只读取一次 Git 元数据；由此，系统不会观察到会话中途的分支切换。

## 如何解除拒绝

是否满足解锁条件由会话的持久日志回放得出：日志中存在一条 `tool/call`，它调用名为 `skill` 的工具，参数可解析为 `{name: <requiredSkill>}`，并且有一条调用 id 相同的非错误 `tool/result` 与之配对。由于日志是唯一状态源，恢复会话时仍能保留这一结果：若恢复的会话已经加载该 skill，系统不会再次要求加载。加载失败、skill 名称不同或参数 JSON 格式错误，都会让拒绝继续生效。

解锁条件按会话独立满足，因此拥有独立会话的 subagent 必须自行加载该 skill。

## 强制执行点

门禁是一个 `tools/pre-execute` 监听器，返回 `{kind: 'deny', reason}`，因此调用绝不会分派执行，文件也绝不会被修改。在所有不违规的情况下，它都会通过 `next()` 委派。这里刻意采用拒绝而非建议性提醒：建议性提醒仍会让违规落地，而在不支持批准的组合中，`ask` 会退化为拒绝。

## 测试

单元测试套件基于真实 Git 元数据 fixture（测试前置数据），使用 mock 适配器驱动真实 agent loop（智能体循环）：覆盖 staging worktree、嵌套其中的任务 worktree、普通克隆、位于 staging 命名分支上的其他仓库、HEAD 分离状态、绝对和相对 `gitdir:` 指针、指向同一仓库的符号链接路径以及不可读元数据，达到逐文件 100% 覆盖率。组装运行层面的证据来自 Loader 组合冒烟测试（`tests/loader-composition.e2e.ts`）：它通过 `examples/headless-agent/tests/fixtures/guard/source-guard/cordis.yml` 启动一个真实的 headless 应用，在临时 cwd 中植入 staging worktree，并断言工具结果是携带精确拒绝文本的错误，同时目标文件保持原始字节不变。

## 模型体验

### 被拒绝的文件系统调用

#### 模型看到的内容

如果未加载必需 skill 就对受保护 worktree 发起受门禁限制的调用，系统会返回错误结果，其中的文本与下文完全一致。系统不会添加提示词段、工具 schema 或成功调用文本；允许的调用与未启用此插件时的调用完全无法区分。

##### 拒绝结果

```markdown
Error: Editing "<path>" directly is not allowed: it is inside the dsh checkout this session is running from, on branch <branch>. Load the <requiredSkill> skill first and follow it — implement in a task worktree, then integrate under the staging lock.
```

#### Token 影响

未发生拒绝时为零 token。一次拒绝会添加一条会保留在历史中的短小错误结果，同时避免生成该调用原本会产生的成功载荷。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓工作

- **`bash` 不受门禁限制**：此插件只为文件系统工具提供边界；shell 命令仍可修改受保护的 worktree。
- **插件生命周期内按目录缓存 worktree 身份**：在会话中途切换受保护 worktree 的分支，不会改变判断结果，直至下次加载插件；目标侧和启动器侧都是如此。
- **仅保护启动器自身的检出目录**：同一仓库中的陈旧同级检出目录会被刻意保留为可编辑状态；若要保护它，请从中运行 `dsh`。
- **源码检出之外不启用**：从已安装副本运行的 harness 不保护任何内容，除非 `protectedCheckout` 明确指定真实检出目录。
- **解锁条件按会话独立满足**：subagent 的会话必须自行加载该 skill；父会话的加载状态不会继承。
- **无法解析 Git 状态时故障放行**：损坏或不可读的 `.git` 会使保护失效；这是刻意选择的结果，因为另一方案是阻止所有编辑。
- **仅加载一个 skill 即可为会话解除整道门禁**：加载该 skill 并不能验证是否实际遵循工作流，只能证明已阅读这些指令。
