# 实操手册：添加工具

[English](adding-a-tool.md) | 中文

如何为模型赋予一项新能力。参考实现：`examples/echo-agent/src/echo-tool.ts`（最小化）和 `packages/bash/tool-bash`（生产级，由三个包（package）构成的 seam）。

## 最小形态

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return [{ type: 'text', text: await readFile(args.path, 'utf8') }]
    },
  }))
}
```

注册基于副作用：dispose（资源释放）插件 fiber 即注销该工具（请编写 HMR（热模块替换）测试）。schema 会自动流入系统提示词的组装过程。

## execute() 契约的规则

- **参数已为你校验。** `defineTool` 在 `execute` 运行前，会根据 `SchemaSpec` 校验模型生成的 `arguments`（类型、必填键、枚举成员、嵌套对象/数组——见[运行时参数校验](../rfc/implemented/architecture/2026-06-11-runtime-arg-validation.md)），因此 `execute` 内部的 args 已匹配 `InferArgs`。你仍需手动检查 DSL 无法表达的值约束（非空字符串、正数、跨字段规则），对这些情况抛出描述性 Error。直接注册的原始 JSON-Schema 工具（MCP）不由 harness 校验，它们自行校验输入。
- **注册借用你的只读定义。** 类型化的同进程贡献不是序列化边界；注册后不要修改其 schema 或替换回调。`schemas()` 只物化显式的模型可见投影。如需热替换工具，请 dispose 其所属副作用并注册替代品；回调闭包内的可变状态仍是普通的插件状态。
- **执行身份受保护。** 注册表在一次递归遍历中将 `arguments` 物化为分离的无损 JSON，在策略开始前冻结该值，并分配一个不透明的 `exec.token`；`callId`、`name`、`arguments`、`agent`、`token` 以及可选的外层传输 `parent` token 在整个分发过程中保持不可变。`parent` 仅用于身份标识，不暴露活跃的外层执行。请将 `args` 视为只读输入。around-dispatch 包装器只能添加、替换或移除 `exec.signal`，以施加取消或截止时间。
- **抛出异常或返回非 JSON 数据意味着 `isError`。** 注册表捕获异常，并在观察者运行前物化最终结果。格式错误或非 JSON 的结果变为 `{ isError: true }`，防止出现无法记录的活跃成功。基础设施故障请抛异常；当模型需要解读领域失败时，请在结果文本中报告。
- **遵守 `exec.signal`。** 信号触发时取消进行中的工作。
- **使用 `meta` 附加持久化的卡片数据（可选）。** `execute` 可以返回 `{ content, meta }` 而非裸的 `ContentBlock[]`。`meta` 是 JSON 可序列化的载荷，核心将其视为不透明数据，持久化在 `tool/result` 事件上并回传给你的 `presentResult`（这样需要 `args` 之外信息的卡片——如 `write`/`edit` 的已应用 hunk diff——在会话回放中依然存活）。仅在此处放 UI 数据，绝不放入模型可见的 `content`。
- **使用 `exec.agent` 发送异步通知。** `agent.inject(content, {source: {kind: 'plugin', plugin: '<name>'}})` 追加持久化上下文，下一次模型请求会看到它——这不是唤醒（空闲的 agent（智能体）保持空闲）。请防范已 dispose 的 agent（try/catch）。

## 长时间运行的工作

通过 producer 配置控制 `run_in_background`，拒绝已预先中止的调用，然后使用 `ctx.tasks.start({ kind, label, owner: exec.agent, run })` 注册任务。运行时会在 `run()` 启动工作前校验 owner 和控制面是否可用，随后提供 id、会话围栏、通用控制工具、通知和 owner cleanup。

producer 提供同步的 `cancel`、在资源清理后 settle 且不 reject 的 `done`，以及可选的消费式 `readOutput`（负责有界输出的格式化）。返回 id 后，应使用 task 自有的取消信号，而不是 `exec.signal`。流式 producer 的示例和完整契约见[后台 task 运行时 RFC](../rfc/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md)与 `dsh-tool-bash`。

## 执行策略与观测

尽量不要把部署策略内建到工具中。使用 `tools/pre-execute` 实现可扩展的允许/拒绝/询问策略（见[权限门禁示例](./extension-cookbook.md#a-hook-plugin-permission-gate-example)）；使用 `ctx.tools.guard()` 设置最终的单调拒绝（后续监听器无法撤销）；使用 `tools/execute` 为核心分发包装截止时间/重试/指标作用域；使用 `tools/post-execute` 转换或附加模型可见的上下文；使用 `tools/result` 观测不可变的归一化结果而不改变它。沙箱实现也可以位于工具执行器的能力 seam 之后；确切契约见 [`dsh-tools` README](../../packages/core/tools/README.md#extension-points)。

## Code Mode 自动触达你的工具

在 [Code Mode](../../packages/core/tools/README.md) 中，每个可见的已注册工具都可通过 `await tools.<name>(args)` 调用，无需额外集成。SDK 从同一份 JSON Schema 派生参数，调用重新进入正常的执行流水线。请将描述写成面向模型的 API 文档；非文本结果块在程序中变为占位符。

## 工具在编辑器中的渲染方式（ACP 展示）

工具的 `execute` 返回模型可见的内容；其**编辑器卡片**是一个独立的、可选的关注点，通过 `defineTool` 选项中的两个纯展示方法声明。请与 `execute` 同步设计，而非事后补充——编辑器（如 Zed，通过 ACP（Agent Client Protocol）桥接）会展示该卡片，没有展示方法的工具回退为一个朴素的通用卡片（标题 = 工具名，原始 args 作为输入）。

两个方法都返回一个 **`card` 标签的渲染意图**——选择与你的工具行为匹配的卡片类型：

- `presentCall(args)` → 一个 `ToolCallView`（PENDING 卡片）：
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }`——默认。设置 `kind` 获取图标（`read`/`search`/…）；设置 `locations: [{ path, line? }]` 标注工具涉及的文件，使有能力的编辑器跟随/跳转。
  - `{ card: 'terminal', title, description?, cwd? }`——你的调用本身就是 shell 命令。`title` 是命令，`description` 渲染在终端卡片上方。（tool-bash。）
  - `{ card: 'diff', title, diffs, locations? }`——你的调用创建或修改文件。`diffs: [{ path, oldText, newText }]`（新文件时 `oldText: null`）渲染为内联 diff 卡片。（tool-fs `write`/`edit`。）
- `presentResult(args, { content, isError, meta? })` 返回完成后的卡片：
  - `generic` 提供可选的标题和内容。
  - `terminal` 提供原始输出和可选的退出元数据；桥接层渲染能力特定或围栏回退视图。
  - `diff` 提供已应用的 hunk，通常由持久化的 `result.meta` 携带，使回放能重现它们。变更类工具保留 diff 结果，因为 ACP 更新会替换 pending 卡片的内容。

硬性规则（违反会出问题）：

- **纯函数。** 这些方法在实时流式输出和会话日志回放时都会运行，因此必须是 `args`（加 result）的纯函数——不做 I/O、不读会话状态、不用时钟/随机数。diff 从 args 派生（`write` 使用 `oldText: null`，因为调用时的展示器没有文件先前内容）；**桥接层**（而非工具）填充会话 cwd 并相对化展示路径标题。如果你发现自己想在 `presentCall` 内获取文件旧内容或工作目录，请停下——那属于桥接层或未来的 result-event 形态，不属于展示器。
- **UI 格式不进入模型结果。** 围栏 ` ```console ` 块、diff、相对化路径——这些都不得出现在 `execute` 返回给模型的内容中；它们只存在于展示层。（`terminal` 结果视图携带原始 `output`；桥接层添加围栏。）
- **`defineTool` 对展示路径做软校验。** 格式错误或旧版日志中的 arg 形态会使包装器返回 `undefined`（通用回退）而非抛异常——展示绝不能导致回放崩溃。

中性词汇定义在 `dsh-tools` 中（绝不在工具中导入 ACP 类型）；ACP 桥接层将每个 `card` 映射到协议格式（wire format）。设计与原因见[渲染意图联合体 RFC](../rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md)；`dsh-tool-fs`（generic/diff）和 `dsh-tool-bash`（terminal）是参考实现。

## 每个工具必须的测试

覆盖参数拒绝、每种结果形态和 HMR dispose。对于有副作用的工具，使用脚本化的 `MockAdapter` 驱动真实工具通过 agent loop（智能体循环），并断言其 `tool/call` 和 `tool/result` 会话事件。对于编辑器卡片，断言 `presentCall` 和 `presentResult` 的精确视图，并通过真实桥接层添加一个 [ACP 快照](../rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md)；终端卡片的场景设置 `terminalOutput: true` 以覆盖 capable-client 路径。
