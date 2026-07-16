# 工具

[English](tools.md) | 中文

[dsh-tools](../../packages/core/tools) 的工具流水线。[core.md](core.md) 介绍了 `ToolDefinition` 作为唯一被提升到主干的流水线编写类型，以及 `ToolSchema` 作为面向模型的协议格式（wire format）。本页拥有完整的 `ToolDefinition`、构建它的类型化 schema DSL、带守卫的执行形状，以及 UI 展示词汇。

源码：[`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition`：一个已注册的工具

一个 `ToolSchema`（面向模型的字段）加上 `execute` 函数与可选的 UI 展示器。注册表持有这些定义；agent loop（智能体循环）通过它们分发调用。注册表的 `schemas()` 通过显式白名单构建面向模型的 `ToolSchema[]`：`execute`/`presentCall`/`presentResult` 绝不能泄漏到模型请求中。

```ts type-equiv
interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ToolExecuteReturn>
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * `result` (`execute`'s content + whether it errored). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

`execute` 接收 `args: unknown`：原始的 `ToolDefinition` 自行校验输入。第一方工具不需要手写校验；它们使用 `defineTool`，由后者代为校验和收窄类型。

## 类型化 schema DSL

插件作者为每个属性编写带有布尔值 `required: true` 的规格，类型层面的辅助工具将规格映射为 `execute` 的参数类型——零类型断言。该 DSL 是为 `ToolDefinition` *提供类型*的机制；它有意作为子页面细节，不属于核心。

源码：[`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts)

```ts type-equiv
interface SchemaProp {
  type: SchemaType
  /** Per-property required flag (NOT the JSON Schema top-level required array). */
  required?: true
  /** Human-readable description, surfaced in the JSON Schema as well. */
  description?: string
  /** Enum of allowed values (strings only). */
  enum?: string[]
  /** Default value. */
  default?: unknown
  /** Nested properties for type: 'object'. */
  properties?: SchemaSpec
  /** Items schema for type: 'array'. */
  items?: SchemaProp
}
```

```ts type-equiv
type SchemaSpec = Record<string, SchemaProp>
```

`SchemaType` 是原始联合类型 `'string' | 'number' | 'boolean' | 'object' | 'array'`。`InferArgs<S>` 将一个 `SchemaSpec` 映射为 TS 参数类型：`required: true` 的属性成为必选键，其余为真正的可选：

```ts type-equiv
type InferArgs<S extends SchemaSpec> = Simplify<
  & { [K in RequiredKeys<S>]: InferPropValue<S[K]> }
  & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferPropValue<S[K]> }
>
```

`defineTool({ name, description, parameters, execute, … })` 将各部分串联：`parameters` 是一个 `SchemaSpec`，`execute(args, exec)` 得到 `args: InferArgs<typeof parameters>`，辅助函数将规格转换为 JSON Schema（`schemaSpecToJsonSchema`）用于协议传输，并在类型化函数体运行前校验模型生成的参数（`validateArgs`）。不匹配时抛出 `ToolArgsError`（`code: 'INVALID_ARGS'`），注册表将其转为 `isError` 结果以便模型自我修正。为什么用自定义 DSL 而非 schemastery：工具参数需要的是 JSON Schema（LLM（大语言模型）协议格式），不是校验/转换——轻量 DSL 以最小表面积提供最佳编写体验。

注册是受信的同进程契约。注册表以 readonly 方式借用类型化定义作为输入，仅校验语义要求（如 `timeoutMs` 必须为正有限值）；`schemas()` 在模型边界处具象化显式的面向模型投影，使执行与展示共享同一份已解析定义，而不会将回调泄漏到协议上。

## `ToolRestriction`：单个作用域的实时全局过滤器

`ToolRestriction` 仅作用于实时的部署全局工具层。注册表将 readonly 名称编译为私有集合，对多个限制取交集，再叠加作用域本地工具。仅 deny 的过滤器允许后续未列出的全局工具通过，而 allow 列表则排除它们。

```ts type-equiv
interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}
```

## 执行：可扩展的 waterfall（瀑布式事件）加单调策略

`ctx.tools.execute()` 接受调用方拥有的 `ToolExecutionInput`，将其解析后的 JSON 参数一次性具象化为流水线拥有的 `ToolExecution`，然后将该调用依次通过 `tools/pre-execute`（可重排的 allow/deny/ask waterfall）→ 已注册的单调守卫 → `tools/execute`（around-dispatch 包装层）→ `tools/post-execute`（检查/替换结果）→ `tools/result`（不可变的权威结果）。最终结果是一个 `ToolExecutionResult`。

```ts type-equiv
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Parsed JSON arguments (unknown — tools validate their own input). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Opaque token of the enclosing transport execution, when one exists. Code
   * Mode sets this on SDK sub-dispatches so commit-style observers can wait for
   * the outer `run_code` outcome without receiving its live mutable execution.
   */
  readonly parent?: ToolExecutionToken
  signal?: AbortSignal
}
```

```ts type-equiv
interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}
```

`ToolExecutionToken` 是一个不透明的运行时 `Symbol`，仅用于身份比较。在策略执行之前，`execute()` 具象化并冻结参数、拒绝非 JSON 输入、分配 token。身份字段和可选的 parent token 保持 readonly；只有 `signal` 可在 dispatch 前后变化。最终观察者接收到的是冻结的执行身份。

`ToolGuard` 是感知作用域的最终 pre-dispatch 策略。其形状有意不包含 allow 结果：`undefined` 保留 waterfall 的决策，而返回的 reason 只能缩减权限，因此后续监听器无法撤销它。

```ts type-equiv
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

```ts type-equiv
interface ToolExecutionResult {
  content: ContentBlock[]
  isError: boolean
  /**
   * Set when the call failed with a {@link HarnessError}: machine-routable
   * `{ name, code }` for retry/sandbox plugins and replay. The model-facing
   * text in `content` is always present; this is extra structure for code.
   */
  error?: ToolErrorInfo
  /**
   * Extra model-facing context a `tools/post-execute` listener attached for the
   * NEXT request (Claude Code's PostToolUse `additionalContext`). It is NOT part
   * of this call's `content` — `content`/`feedback` shape the tool RESULT, but
   * `additionalContext` is a SEPARATE `context/message`. A step can carry
   * multiple tool calls, so the loop BUFFERS every call's `additionalContext`
   * and appends them only AFTER all `tool/result`s for the step, keeping
   * tool-call/result adjacency intact. Carried on the result purely to ferry it
   * from `execute()` up to the loop's per-step buffer.
   */
  additionalContext?: HookContext
  /**
   * The tool-private presentation payload from a successful `execute` (the object
   * return form). Threaded onto the `tool/result` session event and back into
   * {@link ToolResult} for `presentResult`. Opaque (`unknown`); absent when the
   * tool attached none or the call failed.
   */
  meta?: unknown
}
```

结果仅承载结果本身。调用身份保留在不可变的 `ToolExecution` 上，后者伴随结果通过每个钩子，也保留在持久化的 `tool/call` / `tool/result` 会话事件上，因此包装层无法创建第二个相互矛盾的身份。

注册表在 `tools/result` 之前立即具象化并冻结最终接受的结果。其 content、结构化错误、附加上下文和展示元数据必须通过 JSON 无损往返；无效结果会被转为 JSON 安全的 `isError` 结果，确保被观察到的实时结果对后续持久化的 `tool/result` 追加是安全的。

每个拦截 waterfall 返回一个类型化的 **Decision**（与 `agent/*` seam 共享的惯用模式）。`tools/pre-execute` 监听器接收 `(exec, next)` 并返回 `PreToolDecision`；`tools/execute` 包装层返回 `ToolExecutionResult`；`tools/post-execute` 监听器接收 `(exec, result, next)` 并返回 `PostToolDecision`：

```ts type-equiv
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

```ts type-equiv
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContext?: HookContext }
```

调用 `next()` 走默认路径，或返回 decision 以短路。Pre-policy 可以 deny 或 ask；只有 `allowed-once` 才继续执行，而 non-grant、缺少审批通道或服务、或无 agent 的请求都会变为 denial。守卫仍可施加最终 denial。参数不可被改写，因为历史记录、审计、UI 和执行必须一致。

Post-policy 可以替换 content；block 会变为包含其纠正反馈的 `isError` 结果。`tools/result` 在归一化后接收冻结的执行和结果；观察者无法转换它们，观察者的失败被隔离。未知工具和抛出异常的工具都变为结构化错误（`ToolNotFoundError` 映射为 `UNKNOWN_TOOL`），调用失败但不终止当前轮次。

## 结构化输出 schema 子集

调用方用来向 subagent 要求机器可读结果的词汇（`SubagentStartRequest.outputSchema`，见 [subagent.md](subagent.md#the-start-request)），或工作流 `agent()` 调用使用的词汇。它有意**不是**完整的 JSON Schema：schema 原样传递给模型作为强制工具的 `parameters`，产出的值由客户端的 `validateStructuredValue` 校验——因此每个被接受的关键字都必须是校验器实际执行的，`assertSupportedOutputSchema` 会大声拒绝其他任何内容（`OutputSchemaError`，列出所有违规）。两个遍历器都只处理自有可枚举属性（JSON 不携带其他东西），并拒绝会有损序列化的非普通对象（`Date`、`Map`）。

```ts type-equiv
type StructuredScalar = string | number | boolean | null
```

```ts type-equiv
type StructuredSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
```

```ts type-equiv
interface StructuredSchemaNode {
  type: StructuredSchemaType
  properties?: Record<string, StructuredSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: StructuredSchemaNode
  enum?: StructuredScalar[]
  const?: StructuredScalar
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}
```

schema 是一个以 object 为根的节点（`enum`/`const` 仅限标量；`description`/`title`/`default`/`examples` 是注解，允许但忽略，仍要求为 JSON 数据——它们随协议传输）：

```ts type-equiv
type StructuredOutputSchema = StructuredSchemaNode & { type: 'object' }
```

## 工具展示 UI 词汇

工具希望其调用在 UI 中如何呈现（编辑器工具调用卡片、CLI 日志行），提供方无关，使工具无需依赖任何客户端协议即可描述自身。`presentCall`/`presentResult` 返回一个 **`card` 标签的渲染意图**——一个可辨识联合类型，UI 桥接层据此分发：

- `ToolCallView`（pending 状态）：`{ card: 'generic', title, kind?, rawInput?, content?, locations? }`（默认卡片；`locations` 是 `{ path, line? }[]`，表示该调用读取/修改的文件，供编辑器跟随定位）、`{ card: 'terminal', title, description?, cwd? }`（shell 命令 → 终端卡片）、或 `{ card: 'diff', title, diffs, locations? }`（文件创建/修改 → 内联 diff 卡片；`diffs` 是 `{ path, oldText, newText }[]`，`oldText: null` 表示新文件）。
- `ToolResultView`（completed 状态）：`{ card: 'generic', title?, content? }`、`{ card: 'terminal', title?, output?, exitCode?, signal? }`（捕获的运行输出 + 退出状态；有能力的 UI 显示退出状态标签，无能力的 UI 获得桥接层从 `output` 派生的围栏 ` ```console ` 回退）、或 `{ card: 'diff', title?, diffs }`（已完成的文件变更 → 要展示的变更，通常是从 before/after 内容计算出带上下文行的已应用 hunk，或在没有 before-image 时的整文件 diff——如文件创建。`tool_call_update` 的 content 会**替换**调用的 content，因此变更工具即使与调用时的片段重复也要返回此值，以防结果文本覆盖 diff）。

`ToolCallKind`（`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`）为 generic 卡片选择图标。`FileLocation`（`{ path, line? }`）和 `FileDiff`（`{ path, oldText, newText }`）是共享的文件卡片词汇。该设计固定于[渲染意图联合类型 RFC](../rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md)；ACP（Agent Client Protocol）桥接层将 `diff` 卡片映射为 `{ type: 'diff' }` 内容块，将 `terminal` 卡片映射为 `_meta` 终端约定，并将文件卡片的标题相对于会话 cwd 做相对化处理。

完整的展示字段文档见 [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)。bash 工具自身的 schema（`bash`/`bash_output`/`bash_kill`）及其驱动的执行器见 [bash.md](bash.md)。
