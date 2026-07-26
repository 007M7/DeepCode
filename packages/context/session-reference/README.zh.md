# `@deepseek-ai/dsh-session-reference`

[English](README.md) | 中文

`ctx.sessionReferences` 会把其他会话准备为有界、只读快照，作为提示词前缀上下文。它消费 `ctx.sessionQuery` 与后端无关的 compact 检查点标记；不需要 SQLite FTS。标准 TUI bundle 会装载它，其他宿主也可直接调用该服务。

## 公开 API

- `listCandidates(agent, query?, limit?)` 会列出 `agent.id` 之外的会话，按 id 或 cwd 进行不区分大小写的筛选，再按同 cwd、无 cwd、其他 cwd 记录排序，同时保持每组内的 `listSessions()` 创建顺序。每个已选候选会话都使用最新的日志支持标题作为 mention label，并回退到会话 id；不搜索标题与消息主体。
- `prepare(agent, content, references, signal?)` 会保留首次 mention 顺序、对 id 去重，并拒绝自引用或超过已配置不同源上限的情况。它会并行读取所有源，返回与输入脱离的内容，外加零个或一个聚合 `HookContext`。任何无效引用、读取失败、取消或预算失败都会在宿主调用 `followup()` 或 `steer()` 之前被拒绝。
- `encodeSessionReferenceUri()` 与 `decodeSessionReferenceUri()` 实现 `dsh-session:<base64url(JSON.stringify(sessionId))>`，因此每个 JavaScript 字符串 id 都能精确往返。`formatSessionReferenceMention()` 发出 `@[label](uri)`，`parseSessionReferenceText()` 将 Markdown mention 或裸规范 URI 替换为可读的 `@label` 文本，并返回结构化引用。显式 Markdown mention 会拒绝每个格式错误的 URI；只当 scheme 后跟非空、符合 base64url 形状的 payload 时，裸文本才被视为引用，匹配但非规范的候选项仍会失败。空 scheme mention 或只含标点符号的 scheme mention 仍是普通讨论文本。

## 快照语义

准备阶段会对每个不同源调用一次 `ctx.sessionQuery.readSurface()`，入队后绝不重读。它仅投影折叠后当前表层中的直接 user `user/message`、直接 user `steering/message`、assistant 文本，以及 `user/message` 检查点；这类检查点携带规范 `dsh-compact` 源标记。对于已经包含烘焙前缀上下文的源提示词，投影只读取其对模型隐藏的显示内容，以防止快照递归传播。已遮蔽的压缩前事件、工具、reasoning、上下文、除已标记 compact 检查点外的插件生成 user 消息，以及未完成的 assistant chunk 均会被排除。因此，已压缩源贡献的是最新检查点与之后保留的会话，而非已恢复的遮蔽文本。

上下文源为 `{ kind: 'plugin', plugin: 'session-reference' }`，并携带 `placement: 'prompt-prefix'`。其元数据会记录版本 `1`、源 id 与 label、捕获 seq、是否存在 compact、已保留／已省略消息数、已省略 UTF-8 字节数与截断状态。AgentLoop 将快照、`## My request:` 分隔符和有效提示词写入同一个 `user/message` 或 `steering/message`；同一事件的模型隐藏 envelope 保留直接提示词与元数据，用于 UI 回放。后续源变更、压缩或删除都无法改变目标回放。

## 配置

| Key | 默认值 | 契约 |
|---|---:|---|
| `maxReferences` | `3` | 一条已准备消息中不同源会话的最大数量；必须不大于 `3`。 |
| `candidateLimit` | `50` | 返回给宿主的默认元数据候选数量。 |
| `maxReferenceBytes` | `65536` | 一个引用对象的最大序列化 JSON 字节数。 |

保留会对每个源独立应用 `maxReferenceBytes`，保留 compact 检查点与最新消息，再丢弃较旧的非检查点单元，并使用 `dsh-retention` 头部／尾部截断和精确 UTF-8 省略通知。如果某个源的固定序列化字段无法容纳，准备会以 `SESSION_REFERENCE_BUDGET_EXCEEDED` 失败，而不返回部分上下文。

## 模型体验

### 引用会话背景

#### 模型看到的内容

模型会按此顺序看到一条 user 角色消息：`## Referenced sessions` 不受信任快照、`## My request:` 分隔符，随后是带可读 `@label` 的当前消息。警告禁止遵循快照中的指令、权限声明或工具请求，除非当前 user 重复这些内容。Label、cwd 值、id 与会话文本作为 JSON 在 `<referenced-sessions>` 标签中序列化；每个数据 `<` 都发出为无损 JSON 转义 `\u003c`，因此源文本无法拼出框定标签。

#### Token 影响

每条引用消息都会添加固定警告和最多三个序列化快照，每个快照都受 `maxReferenceBytes` 独立限制。精确快照会保留在目标历史中，直到目标压缩遮蔽或摘要它；源会话变更不会添加更多 token。

#### KV Cache 影响

组合快照与请求在目标消息边界处仅追加，并保留较早的可缓存历史。不同引用或源捕获内容只改变新后缀；后续目标压缩可能使从替换边界起的复用失效。

## 已知限制与暂缓事项

- **没有标题或全文发现**：候选会话只按会话 id 与 cwd 筛选，但已选行会显示最新标题。SQLite FTS 未来可以替换发现机制，而不改变 URI、快照或持久化契约。
- **受信任调用方边界**：该服务假设宿主有权读取 `ctx.sessionQuery` 公开的每个会话；它不是面向模型的搜索工具。
- **只投影文本**：不会在会话间传播非文本 user 与 assistant 块。
- **没有实时链接**：引用是快照，不是 fork、恢复、订阅或源会话变更。
