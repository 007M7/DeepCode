# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

面向模型的 skill 目录和 `skill` 工具。

需要 `ctx.agents`、`ctx.tools` 和 `ctx.skills`（`inject: ['agents', 'tools', 'skills']`）。

## 目录生命周期

该插件通过 `agent/session-prefix` 提供初始的用户角色 `<system-reminder>` 目录。之后每个模型步骤开始前，它都会观察 `ctx.skills.snapshot()`，并针对 `skill` 工具的精确可见性，以及按顺序渲染的 `name` 和 `description` 条目计算 digest。它根据调用会话的 cwd 解析 skill，且只列出这些摘要；skill 正文、路径、来源、提供方和 `whenToUse` 提示仍位于目录之外。

该 digest 变化时，`agent.inject()` 会记录一条持久的用户角色消息，其中包含完整替换目录和元数据 `{ kind: 'skill-catalog', version: 1, digest }`。空替换会显式停用较早目录中的名称。恢复后，最新且仍可见的元数据充当比较基线；若压缩（compaction）遮蔽了替换消息，模型步骤前的观察会改以会话前缀为基线，并在必要时重新发布当前完整目录。提供方快照不完整时，插件不会发送任何内容，并会保留最后一次完整的模型视图，以便在下一步骤重试。若不存在先前目录且当前视图为空，则不需要 tombstone。

如果最初没有模型可调用 skill，则省略目录；如果该 agent 的工具视图排除已发布的 `skill` 工具，或解析出一个同名作用域遮蔽，也会省略目录。可见性变更参与 digest 计算，使提示词指引、模型可见 schema 和可执行分派保持对齐。

`catalogDescriptionMaxLength` 控制规范化且经 XML 转义的目录描述。其默认值是 `500`，且必须是不小于 `3` 的整数，以便为截断省略号保留空间。[会话前缀 Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-session-prefix.md) 定义了初始消息仅存在于请求中、记录于 header 的生命周期；[skill 目录热刷新 Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-skill-catalog-hot-refresh.md) 负责定义持久替换。

## 工具：`skill`

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string（必填） | 可用 skill 列表中精确的 kebab-case skill 名称。 |

执行使用调用 agent 的 `session.header.cwd`，使工作区敏感提供方解析胜出 skill。成功调用返回规范 `{ name, provider, resourceBase?, content }`，排除目录 rank 和提供方内部机制；其 Native 渲染器产生一个文本结果，其中包含 `<skill_content name="...">`、`<skill_resources>` 和 `<skill_instructions>`。

资源指引只会根据 `resourceBase` 解析指令显式引用的路径或 URL；脚本、参考资料和产物按需加载，结果不会列举 skill 目录。本地提供方可以提供目录，而远程或嵌入式提供方可以提供 URL 或不透明加载指引。

无法解析的名称会报告 skill 未知或已不可用。无效名称和 `disableModelInvocation: true` skill 产生不同的错误结果。

工具执行不调用 `agent.inject()`。新加载的结果已作为工具结果记录，并在下一个模型步骤可用，无需将正文重复为合成上下文。只有目录投影会注入替换摘要。

## 模型体验

### 会话前缀

#### 模型所见

如果存在模型可调用 skill，且该精确 `skill` 工具可见，agent 会收到下方目录模板，其中包含每个已排序 skill 的一条数据依赖条目。初始目录是用户角色会话前缀。后续成员关系、描述或可见性的变化会使用同一个 `<available_skills>` 信封追加完整替换；删除所有 skill 时，会追加一个空信封，并明确指示不得使用旧名称。

##### Skill 目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
</system-reminder>
```

#### Token 影响

重复输入成本随 skill 数量和 `catalogDescriptionMaxLength` 增长；当列表为空或工具被隐藏或遮蔽时，不会发送初始目录 token。每次实际目录变更都会添加一条保留的完整替换消息。

#### KV 缓存影响

初始目录保持前缀稳定。动态变更作为该前缀之后的仅追加历史，因此现有可重用 token 保持不变，替换消息和后续轮次则形成新的后缀。

### 工具 schema

#### 模型所见

模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill)。

#### Token 影响

工具可见时，每次请求都有固定 schema 成本。

#### KV 缓存影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型所见

成功调用使用下方结果模板，以及由提供方管理、目录、URL 或不透明的资源指引。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV 缓存影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV 缓存条目失效。

### 工具错误

#### 模型所见

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。提供方抛出的查找文本取决于数据，并接收同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV 缓存影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV 缓存条目失效。

## 已知限制与待完成工作

- **目录省略 `whenToUse`、来源和提供方元数据**：路由只基于名称和有上限描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **已加载指令正文没有大小上限**：提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。
- **资源是指引，而非附件**：工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**：远程提供方缓慢或 skill 正文很大时，不提供部分、流式或缓存内容句柄。
- **目录替换采用全量列表**：一个名称或描述发生变化，就会追加当前所有可见摘要；这样能显式停用陈旧名称，但 token 成本与目录大小成正比。
- **正文不做版本化**：仅修改正文不会改变目录 digest，也不会通知模型；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。
