# RFC：工具调用超时策略作为插件

Status: implemented

[English](2026-07-07-tool-call-timeout-policy.md) | 中文

## 问题

[超时/截止时间 RFC](2026-07-06-timeout-deadline-library.md) 将计时与分类原语提取到了 `@deepseek-ai/dsh-timeout`，但超时策略仍然附着在各个能力和面向模型的 schema 上。`bash` 暴露了 `timeoutMs`；`web_fetch` 暴露了 `timeout_ms`；`web_search` 没有面向模型的超时参数，尽管提供方已经遵守 `exec.signal`；未来的 grep/glob 工具要么直接导入超时库，要么自行发明超时策略。对于一个插件 SDK 来说，这是错误的编写形态：工具作者通常只需将 `exec.signal` 转发给所调用的实现，而部署策略来决定预算。

与此同时，仓库中并非所有超时都是面向模型的工具调用预算。钩子通过直接调用 `ctx.bash` 来执行命令钩子，而非通过 `ctx.tools.execute()`；`bash` 模型工具通过同一后端复用了前台执行、后台启动、后台轮询和钩子调用。一步到位地把所有超时都移入工具插件会混淆这些路径，并有破坏钩子超时语义的风险。

## 决策

工具调用超时是一项仅适用于面向模型的工具执行的策略，由三部分组成：

- `@deepseek-ai/dsh-timeout` 仍然是拥有 `deadline()` 和 `timeoutOf()` 的共享库。
- `@deepseek-ai/dsh-tools` 在 `tools/pre-execute` 和 `tools/post-execute` 之间有一个环绕分发的 waterfall（瀑布式事件）`tools/execute`。
- `@deepseek-ai/dsh-timeout-policy` 从注册表读取每个工具声明的 `timeoutMs`，并通过派生新的 `exec.signal` 来包装有此声明的调用。

执行流水线为：

```text
ctx.tools.execute(exec)
  -> tools/pre-execute
  -> tools/execute
       -> registry dispatch (the base next())
            -> tool.execute(args, exec)
            -> thrown tool errors normalize to ToolExecutionResult
  -> tools/post-execute
```

默认行为是保守的：未声明 `timeoutMs` 的工具不会从该插件收到 `TOOL_TIMEOUT` 截止时间。

### `tools/execute` 环绕 seam

`@deepseek-ai/dsh-tools` 声明了一个 `tools/execute` waterfall，其基础 `next()` 是「分发并规范化」的 thunk：即同一个内部 `try`/`catch`，它将抛出的工具错误（或未知工具错误）转换为 `isError` 的 `ToolExecutionResult`。监听器接收 `(exec, next)`：调用 `next()` 委托给分发（返回其结果，可选地包装），或返回替代结果以短路分发。整条流水线仍处于 `execute` 的外层 try/catch 之内，因此抛出异常的监听器会变成 `isError` 结果，永远不会导致轮次失败。

catch 是基础 `next()` 而非 waterfall 之外的东西，这一点是关键：当提供方看到超时信号并抛出自己的上游中止错误时，注册表分发首先将其转换为正常的错误结果，然后 `timeout-policy` 才能将最终结果替换为 `TOOL_TIMEOUT`。

### `timeout-policy` 插件

该插件是 `@deepseek-ai/dsh-timeout-policy`，位于 `packages/timeout/` 分组中，是一个零配置的函数/命名空间插件（`name` / `inject` / `apply`）。每个工具的预算声明在工具自身上，而非此插件上：`ToolDefinition` 携带可选的 `timeoutMs`，由拥有该工具的插件从自身配置中设置。例如 `dsh-tool-web` 将 `fetchTimeoutMs` / `searchTimeoutMs`（默认 30000）解析到 `web_fetch` / `web_search` 的定义上：

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-timeout-policy'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchTimeoutMs: 30000
    searchTimeoutMs: 30000
```

超时声明在工具定义上而非自由文本的名称映射中，消除了拼错名称导致策略不生效的问题。`defineTool` 会校验预算为正有限数。分发期间，执行器派生截止时间信号，之后恢复调用方信号，并将自身的超时转换为 `TOOL_TIMEOUT`；没有预算的工具原样通过。

信号替换采用**就地修改 `exec.signal`** 的方式，而非向 `next()` 传递新对象。Cordis 的 waterfall `next()` 忽略传入的参数，使用共享的 payload 数组重新调用下游监听器（`vendor/cordis/src/events.ts`），因此 Cordis 的文档惯用法——修改共享对象再委托——是唯一能到达分发的机制。插件在 `finally` 中将 `exec.signal` 恢复为调用方的原始信号，使 `tools/post-execute` 永远不会看到此插件的（可能已中止的）截止时间信号。

`timeout-policy` 拥有 `TOOL_TIMEOUT` 代码的两种用途：传递给 `deadline()`/`timeoutOf()` 的内部截止时间代码（作用域化，使嵌套的外层截止时间读取为普通取消），以及结构化工具结果的错误代码。其替换结果为：

```ts ignore-check
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: `Error: tool call timed out after ${timeoutMs}ms` }],
    isError: true,
    error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
  }
}
```

这是一个协作式截止时间。它不会通过与工具 promise 竞速来杀死任意工作；工具或其调用的能力必须遵守 `exec.signal` 并达到静止状态。因此声明 `timeoutMs` 的含义是「此工具对 `exec.signal` 是协作式的」，插件 README 将此作为契约声明。

可重建性不需要新的会话事件：`TOOL_TIMEOUT` 就是该调用最终面向模型的 `tool/result`，因此现有会话日志已经记录了下一次模型请求所看到的内容和结构化 `{ name, code }` 错误。

### 现有工具适配

`web_fetch` 和 `web_search` 已迁移。`dsh-tool-web` 保留对其面向模型 schema 的所有权，这些 schema 不暴露超时旋钮：`web_fetch` 移除了 `timeout_ms` 参数以匹配参考 agent 的形态，`web_search` 保持仅查询。工具体不导入 `@deepseek-ai/dsh-timeout`；它们将 `exec.signal` 转发给 `ctx.web`。

`dsh-web-fetch-local` 保留一个配置的提供方级 `timeoutMs`，作为直接调用 `ctx.web.fetch()` 的调用方和配置错误部署的大资源兜底；它不拥有面向模型的超时。当 `TOOL_TIMEOUT` 信号先到达 fetch 提供方时，提供方作用域的分类将其视为上游 `WEB_ABORTED`，外层 `tools/execute` 包装器将最终工具结果替换为 `TOOL_TIMEOUT`。已发布的 web 工具部署将提供方兜底配置为高于 `timeout-policy` 预算，使工具调用策略在模型调用中通常获胜。

`bash` 保持当前的后端超时路径。`dsh-tool-bash` 继续暴露 `timeoutMs` 和 `run_in_background`；`dsh-bash-local` 继续使用 `@deepseek-ai/dsh-timeout` 处理 `BASH_TIMEOUT`；钩子桥接继续调用 `runHook()` 并通过 `ctx.bash` 传递 `timeoutMs`。这保持了前台/后台/钩子行为的稳定。

`read`、`write`、`edit`、`todo_write`、`bash_output` 和 `bash_kill` 不加入工具调用超时：它们是本地文件系统或短暂的注册表/会话操作，截止时间对它们要么只能尽力而为，要么没有必要。

未来面向模型的 grep/glob 工具可以基于 `ctx.bash` 实现，无需导入 `@deepseek-ai/dsh-timeout`：它将 `exec.signal` 转发给 `ctx.bash`，并声明自己的 `timeoutMs`（来自其插件配置）供执行器应用。如果 bash-local 的后端超时对此类工具造成问题，bash seam 可以后续添加调用方拥有截止时间的模式；那不在本次范围内。

## 曾考虑的替代方案

**将插件命名为 `tool-timeout`。** 字面的 RFC 名称匹配了 `gen-tool-catalog` 完整性守卫的 `packages/*/tool-*` glob，该守卫要求每个匹配项注册一个面向模型的工具。此插件不注册任何工具——它是 `tools/execute` 的包装器——因此 `tool-*` 名称要么导致 `verify-tool-catalog` 失败，要么强制一个误导性的启动条目。包名为 `@deepseek-ai/dsh-timeout-policy`，位于新的 `packages/timeout/` 分组；cordis.yml 的 `id` 仍可为 `timeout-policy`。

**仅保留逐工具的超时处理。** 这是 `bash` 和 `web_fetch` 的原有形态，也与 Claude Code 和 Codex 对 shell 命令的做法一致。对 web 类工具而言它不够好，因为每个新的支持超时的工具都必须自行选择校验、上限语义、文档、快照和分类。插件集中了策略和分类，同时让每个工具的 schema 专注于业务输入。

**立即将所有超时策略移出 bash-local。** 长期更干净：bash-local 将变为纯子进程执行器，所有调用方拥有自己的截止时间。作为第一步它不合适，因为钩子直接调用 `ctx.bash`，而 bash 模型工具有前台/后台语义，这与工具调用的生命周期不同。保留 `BASH_TIMEOUT` 维持了这些路径的稳定，同时工具调用超时在更简单的工具上验证自身。

**为所有工具使用全局默认预算。** 方便，但会让工具作者意外：任何偶然运行超过全局预算的工具在插件加载后就会开始失败。逐工具声明的预算使采纳成为有意识的行为。

**暴露面向模型的 `timeout_ms` 覆盖参数。** Claude Code 的 `WebFetch`/`WebSearch` 和 Codex 的 web 工具将超时排除在模型调用形态之外。模型覆盖会使超时成为提示词语义的一部分，并迫使 `timeout-policy` 引入 schema/参数剥离规则。Web 超时仅作为部署策略。

**让 `timeout-policy` 自行匹配工具参数。** 类似「当 `bash.run_in_background` 为 true 时禁用超时」的规则引擎会使策略插件了解工具特定的参数语义。通过不将 bash 迁移到工具调用超时来避免此问题。

**使用 `tools/pre-execute` 加 `tools/post-execute` 代替新的环绕 seam。** pre 监听器可以启动截止时间并修改 `exec.signal`；post 监听器可以分类并替换。这不可行，因为截止时间的生命周期将跨越两个独立的 waterfall：需要 call-id 映射、在每个 pre-deny/tool-throw/post-throw/dispose 路径上清理，以及与其他监听器的排序规则。`tools/pre-execute` 也是允许/拒绝门禁，而非执行包装器。`tools/execute` 给超时一个词法作用域：启动、委托、分类、释放。

**使用 `Promise.race` 为非协作式工具强制超时。** 否决，原因与超时库 RFC 相同：它在底层进程、fetch 或提供方操作可能仍在运行时就将控制权返回给调用方。插件只发送信号；终止仍是实现方的责任。

## 后果

- `@deepseek-ai/dsh-tools` 在有意拆分 pre/post 工具钩子的拦截 seam 之后，获得了一个环绕分发的表面。其契约是窄的：包装注册表分发，而非替代 pre 门禁或 post 结果策略；基础 `next()` 是「分发并规范化」，因此包装器永远不会看到原始的工具抛出。
- 多个 `tools/execute` 监听器通过普通的 Cordis waterfall 顺序组合：调用 `next()` 的监听器包装下游监听器加分发；不调用 `next()` 直接返回的监听器短路它们。组合超时与未来的重试/沙箱/指标包装器的部署通过注册顺序选择语义（「超时覆盖整个重试」vs「超时覆盖每次尝试」）。
- 按声明加入是一个有意的配置错误风险：工具可以声明 `timeoutMs` 但不遵守 `exec.signal`，这样的工具在超时时不会停止。插件契约声明：声明预算意味着协作式；web 工具在已经转发信号的工具上证明了这一模式。
- 过渡期间 `bash` 和已迁移的 web 工具有意使用不同的超时路径：`TOOL_TIMEOUT` 是面向模型的工具调用预算，而 `BASH_TIMEOUT` 仍然是 bash 和钩子使用的 bash 后端超时。
- 与字面提案的偏差，按已实现 RFC 规则记录：插件包名为 `@deepseek-ai/dsh-timeout-policy`（而非 `tool-timeout`），信号替换是在 `next()` 之前就地修改 `exec.signal`（而非 `next({ ...exec, signal })`，Cordis 会忽略后者），逐工具预算声明在 `ToolDefinition` 上（`timeoutMs`，由拥有该工具的插件从其配置中设置）而非在此插件的配置中按工具名映射——因此执行器是零配置的，拼错工具名不可能发生。以上三点均在「## 决策」中描述。
