# @deepseek-ai/dsh-command-feedback

[English](README.md) | 中文

面向用户的 `/feedback` 采集。该插件通过 [`ctx.commands`](../../ui/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现它；随附 TUI 无需模型轮次即可执行。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/feedback <text>` | 以 `Feedback recorded.` 确认。注册表的 `command/run` 记录携带原样文本。 |
| `/feedback` | 返回一个直接用法错误。仅含空白的输入视为空输入。 |

反馈文本从不被解析：没有截断、大小写折叠或控制词。看起来像另一个命令的文本（例如 `/feedback /plan felt slow`）就是反馈内容。重复执行命令会各自产生自己的记录，不会替换或合并。

## 本插件做什么、不做什么

该命令记录一条评价，不做别的事。它不追加属于自己的会话事件，不启动任何模型工作，本仓库中也没有任何插件读取它的记录。

记录来自命令注册表自身的 `command/run` / `command/done` 配对，由 [`dsh-commands`](../../ui/commands/README.md) 为每个已分发命令追加。这些追加会启动持久化的常规即时排空；注册表与本命令都不会强制 `session/flush`，因此确认文本表示条目已进入日志，而不表示它已经落盘。`command/run` 携带命令名、原样未解析的后缀以及调用来源；配对的 `command/done` 携带结果。两者都仅写入日志，不出现在有序 surface、`deriveMessages()` 以及任何模型请求中。被拒绝的空输入仍会留下该配对，并以 `kind: 'error'` 结算，因此任何条目都不会被误认为已接受的反馈。

曾考虑并否决了专用的 `session/feedback` 事件：它会重复注册表已经写入的记录，而消费方可以依据注册表已存储的命令名筛选反馈。

## 组合

生产方只注入 `commands`。自定义应用挂载注册表以及本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-feedback
  name: '@deepseek-ai/dsh-command-feedback'
```

TUI 应用无条件挂载此命令；它没有配置，也不依赖持久 goal 栈。无头 CLI、ACP 自动化和 JSON-RPC 适配器不消费 `ctx.commands`，因此不会暴露它。

## 模型体验

### 用户 `/feedback` 采集

#### 模型看到的内容

无。斜杠输入、被记录的文本以及确认文本都不出现在模型请求中。注册表的 `command/run` 与 `command/done` 记录仅写入日志且不携带 `surfaceOp`，因此它们绝不会进入有序 surface、`deriveMessages()` 或系统提示词。在某个轮次中记录反馈不会改变该轮次剩余的请求。

#### Token 影响

无直接 token 影响。无论是已接受的条目还是用法错误，都不会在记录所在轮次或此后任何轮次增加模型 token。

#### KV Cache 影响

与模型请求路径无关。记录只追加到会话日志，不触碰已经可复用的请求前缀。本包贡献的任何内容都不会使缓存复用失效。

## 已知限制与暂缓工作

- **没有任何消费方读取被记录的反馈**：采集刻意不产生任何后续动作。这里没有检索、聚合、导出或报告 surface，也没有面向模型的工具读取它；消费方是另一个依据命令名筛选 `command/run` 记录的独立包。
- **没有结构化字段**：一条条目就是一个自由文本字符串，没有类别、严重程度或关联事件链接，因此无法在不重读文本的情况下按主题过滤反馈。
- **不支持修改或撤回**：会话日志是仅追加的，本包也不新增 tombstone，因此错误的条目会一直保留在记录中，只能由后续条目取代。
- **记录中的文本未修剪**：处理器只为校验而修剪；`command/run` 存储原始后缀，包含其前导分隔空白，因此消费方需在读取时修剪。
- **没有显式持久化屏障**：确认文本紧随追加而非 flush，因此紧临崩溃前记录的条目可能与其他未 flush 的尾部一同丢失。为反馈强制同步写盘并不值得；需要该保证的消费方可自行等待 `ctx.sessions.flush(session)`。
- **随附应用中只有 TUI 使用此命令**：无头 CLI、ACP 自动化和 JSON-RPC 适配器不挂载 `ctx.commands`，因此 `/feedback` 在那里不可用。
