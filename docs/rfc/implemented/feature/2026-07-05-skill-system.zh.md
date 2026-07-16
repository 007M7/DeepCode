# RFC：Skill 系统——面向 agent 的渐进式指令披露

Status: implemented

[English](2026-07-05-skill-system.md) | 中文

## 问题

各 agent 产品已趋同于一种 skill 模式：保持请求提示词精简，仅列出可用的指令包，待模型判定任务匹配时再加载完整正文。Codex、Claude Code、OpenCode 和 Kimi Code 在细节上各有不同，但都将发现元数据与完整指令分离，使工作区能承载可复用行为而无需在每个轮次支付全量提示词成本。

DeepSeek Harness 使用同一原语，让项目级的评审指导、插件编写指导和工具使用指导存放在工作区或用户的 agent 配置旁，而非硬编码进 agent loop（智能体循环）。

## 决策

`@deepseek-ai/dsh-skill` 是纯提供方注册表（`ctx.skills`），`@deepseek-ai/dsh-skill-local` 是随附的本地文件系统提供方，`@deepseek-ai/dsh-tool-skill` 负责会话前缀目录和面向模型的 loader 工具。`dsh-agent-spine-demo` 默认加载注册表、本地提供方和消费方，使 stdio 与 ACP 应用获得相同行为，同时嵌入式或远程提供方可在不改动注册表或消费方的前提下贡献 skill。其 `skills` 配置将 `registry`、`local` 和 `tool` 分支分别转发给对应的负责方。

提供方插件在 `apply()` 期间同步注册。提供方成员关系是直接由 effect 持有的状态：注册与 dispose（资源释放）同步地使已完成的目录失效，发现操作按需读取当前提供方映射，而非监听注册表变更事件。提供方目录从 awaited `list()` 调用返回排序后的候选项，远程提供方在此期间执行初始化、认证和发现，同时遵守查找的 abort signal。注册表校验每个候选项，对同名 skill 按 rank、提供方注册顺序和提供方内部顺序执行 first-wins 解析，然后按 skill 名称排序摘要以保证消费方获得确定性结果。注册表仅缓存已完成的目录快照，当提供方/运行时修订版本在发现过程中发生变化时重试，因此 unload 不会将一个陈旧、不可解析的 skill 冻结进会话前缀。运行时 `ctx.skills.register(...)` 仍作为嵌入式进程内 skill 的便捷方式保留，使用 project-over-user 优先级；`runtime` 作为注册表持有的提供方名称被保留。

本地提供方按 first-wins 的 rank 顺序扫描对 cwd 敏感的项目根目录、自定义根目录和用户根目录：项目 `.dsh`、项目 `.agents`、`customSkillDirs`、用户 `.dsh`，然后是用户 `.agents`。用户 `.dsh/skills` 扫描跳过 `.system`，使系统持有的目录不被当作普通用户内容。DeepSeek Harness 不随附内置系统 skill；嵌入式或远程提供方在配置后提供额外 skill。

每个 skill 是 `<name>/SKILL.md` 或带 YAML frontmatter 的 `<name>.md`。`name` 和 `description` 为必填；`whenToUse`、`disableModelInvocation` 和 `metadata` 为可选。名称使用 kebab-case。YAML frontmatter 使用 `yaml` 包解析，而非 `js-yaml` 或手写解析器：`yaml` 是本包有限 frontmatter 需求所声明的现代解析器，手写窄解析器要么拒绝用户期望能正常工作的合法 YAML，要么膨胀为一个未经评审的 YAML 子集。

本地 skill 的文件系统 I/O 在加载了文件系统服务时通过 `ctx.fs` 进行：项目根目录查找使用 `resolve` 和 `stat` 探测 `.git`，根目录发现使用 `listDir`，skill 读取使用 `readText`。对于未挂载 fs seam 的最小上下文，Node 文件系统仍作为回退。缺失的根目录、不可读或格式错误的 skill 文件，以及提供方 `list()` 的瞬态失败均降级为 warn-and-skip，使单个坏源不会导致每个 agent 请求失败；格式错误的候选项仍然快速失败，因为它们违反了提供方契约。

`dsh-tool-skill` 通过 [`agent/session-prefix`](2026-07-07-session-prefix.md) 贡献一条 user-role `<system-reminder>` 目录。目录仅包含排序后的 skill 名称和描述；不包含正文、路径、来源、提供方和路由提示。描述经过空白规范化、XML 转义，并受 `catalogDescriptionMaxLength` 限制，其默认值为 `500`，最小值为 `3`。会话前缀 seam 将仅用于请求的目录按 loop 实例冻结，并记录在请求头中，在不将其加入持久化历史的前提下保持可重建性。完整 skill 正文从不包含在目录中。

`skill({ name })` 工具为当前 agent cwd 加载一个完整 skill，返回包含 `<skill_content name="...">`、`<skill_resources>` 和 `<skill_instructions>` 的工具结果。`resourceBase` 提供一个目录、URL 或不透明的提供方管理的基路径，用于显式引用的脚本、参考资料和资产；资源仅按需加载，不进行目录枚举。无法解析的名称报告该 skill 未知或不再可用；无效名称和标记了 `disableModelInvocation` 的 skill 保留不同的工具错误。工具结果是面向模型的披露路径。

数据结构与目录/工具契约记录在 [skills.md](../../../core-data-structures/skills.md)，服务签名见生成的[服务目录](../../../cordis-catalog/services.md)。

## 曾考虑的替代方案

**将完整 skill 正文注入每条系统提示词。** 否决，因为这破坏了渐进式披露，使每个请求都为可能不适用的指令付出代价。

**仅将 skill 暴露为斜杠命令。** 否决，因为模型主动加载才是核心能力；斜杠/ACP 命令广播不改变发现机制。

**将本地文件系统扫描直接放在 `ctx.skills` 内。** 否决，因为编码 agent、Web agent 和未来的插件生态需要不同的 skill 来源。提供方注册表与 subagent seam 同构：注册表负责冲突解析和消费方，实现负责加载。

**使用系统提示词段落。** 否决，因为渲染后的系统提示词是单一字符串，而目录是一条具有仅请求生命周期要求的 user-role `<system-reminder>` 消息。[`agent/session-prefix`](2026-07-07-session-prefix.md) 是选定的机制：它将目录置于派生历史之前，并将组合后的消息记录在请求头中。

**将内置 DSH 编写 skill 物化到 `~/.dsh/skills/.system`。** 否决，因为打包的 skill 不应在启动时写入用户主目录，嵌入式或远程提供方在配置后提供 skill。

**递归发现嵌套的 `**/SKILL.md`。** 否决。扁平文件和一级目录包已覆盖配置的根目录，同时保持重复处理和目录顺序易于推理。

**手写 frontmatter 解析器。** 否决，因为已接受的 schema 包含一个开放的 `metadata` 对象。窄解析器要么拒绝用户期望能正常工作的合法 YAML，要么膨胀为一个未经评审的 YAML 子集。

## 后果

agent-core 主干包含一个会话前缀贡献者、一个本地提供方和一个面向模型的工具。skill 发现对 cwd 敏感，因此以不同会话 cwd 值创建 agent 的调用方可以按设计观察到不同的项目 skill 覆盖。

目录在固定的根目录集和运行时注册修订版本下是确定性的，但不监听磁盘变化；发现结果被缓存，直到运行时注册使缓存失效或进程重启。

## 延后

fork 式 skill 上下文（`context: fork`）、直接用户/斜杠调用（`user-invocable`）、参数声明与提示（`arguments` 和 `argument-hint`），以及逐 skill 的工具约束（`allowed-tools` 和 `disallowed-tools`）不在已交付的契约范围内。注册表、本地提供方和面向模型的工具不解析、不广播、不强制执行这些字段。
