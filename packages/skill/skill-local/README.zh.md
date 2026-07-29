# @deepseek-ai/dsh-skill-local

[English](README.md) | 中文

`ctx.skills` 注册表的本地文件系统提供方。

该包（package）实现一个 skill（技能）来源。它扫描本地项目、自定义和用户 skill 根目录，解析 `SKILL.md` 或平铺 Markdown skill 文件，并将提供方注册到 `ctx.skills`。注册表仍位于 `@deepseek-ai/dsh-skill`；会话前缀目录和面向模型的 loader 工具仍位于 `@deepseek-ai/dsh-tool-skill`。

## 插件

需要 `ctx.skills`（`inject: ['skills']`）。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 由 [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) 解析的 DeepSeek Harness 配置根目录；扫描该目录下的 `skills`。 |
| `agentsHome` | `$DSH_AGENTS_HOME` 或 `~/.agents` | 为兼容 skill 扫描的共享 agent（智能体）配置根目录。 |
| `customSkillDirs` | `[]` | 在项目根目录之后、用户根目录之前扫描的其他本地 skill 根目录。 |

## 发现

默认根按该提供方的 rank 顺序解析：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

项目根目录是包含 `.git` 的最近祖先目录；如果不存在，则使用当前 cwd。用户 DSH 根目录会跳过其 `.system` 子目录，因此归系统所有的目录不会被当作普通用户 skill。该提供方提供项目和用户 skill；其他提供方可提供内置系统 skill。

当 `ctx.fs` 可用时，发现通过 `ctx.fs.listDir` 列出根，通过 `ctx.fs.readText` 读取 skill 文件，并通过文件系统服务探测 `.git`。完整 skill 加载会将查找中止信号转发给文件系统元数据和内容读取。如果没有文件系统服务，提供方回退到可中止的 Node 文件系统 I/O，使最小本地上下文仍能加载 skill。缺失、不可读或格式错误的 skill 文件会警告并跳过，而不会使整个请求失败。

## Skill 格式

Skill 可以是单层目录 bundle（`<name>/SKILL.md`），也可以是平铺 Markdown 文件（`<name>.md`）。v1 刻意不支持发现嵌套的 `**/SKILL.md`。Frontmatter 使用 `yaml` 包解析为 YAML；它要求 `name` 和 `description`，而 `whenToUse`、`disableModelInvocation` 和 `metadata` 可选。名称必须使用 kebab-case。

## 模型体验

通过 `dsh-tool-skill` 间接影响模型。它将该提供方的可调用名称和有长度上限的描述渲染到会话前缀目录中，并将所选指令正文与资源基底指引渲染到保留的工具历史中；路径、提供方 rank 和已禁用 skill 仍被隐藏。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **发现深度为一层**：只识别 `<root>/<name>/SKILL.md` 和 `<root>/<name>.md`；忽略嵌套 skill 树和包 manifest（元数据清单）。
- **项目范围为最近 `.git` 祖先**：没有该标记的工作区回退到提供的 cwd，不支持其他项目根标记或 monorepo 子项目选择。
- **不可读或格式错误的条目会随警告消失**：模型目录不会收到每个 skill 的诊断，无法区分缺失的 skill 与被跳过的 skill。
- **无文件系统监听**：在重新发现先前已收集的 cwd 之前，编辑内容能否生效取决于注册表缓存是否被淘汰，或是否因提供方重新加载而失效。
