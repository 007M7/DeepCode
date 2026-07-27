# @deepseek-ai/dsh-hook-protocol

[English](README.md) | 中文

Claude Code／Codex hook 协议格式的**共享核心**。它不是 cordis 插件：不注册也不注入任何内容。它是一个**库**，提供两个桥接插件（`@deepseek-ai/dsh-hooks-claude`、`@deepseek-ai/dsh-hooks-codex`）导入的方言无关原语，使两者都无需重复实现协议中相同的部分。

共享 lib 存在的原因是：Codex 有意重新实现了 Claude Code hook 协议的一个*子集*，包括相同的 `hooks.json` matcher group 形状、相同的退出码／stdout 输出契约以及相同的 command hook 执行模式。真正共享的部分位于此处；每个桥接只拥有不同之处。

## 共享内容（此处）与每方言内容（桥接）

| 关注点 | 此处（`dsh-hook-protocol`） | 桥接（`dsh-hooks-claude` / `-codex`） |
|---|---|---|
| Matcher 测试 | `matchesMatcher(pattern, query, mode)`：根据 `mode` 使用字面匹配或正则匹配 | 选择自身 `mode`（`claude` = 字面或正则，`codex` = 始终使用正则） |
| 运行 hook | `runHook(bash, hook, opts, now)`：通过 `ctx.bash` 提供 stdin payload + env，再解码 | 构造每个事件的 stdin **payload** + 该方言的 **env** |
| 解码输出 | `parseHookOutput(exit, stdout, stderr)` → 中性 `HookOutput` | 将中性 `HookOutput` 映射到 seam 特定的类型化 Decision |
| 合并 N 个 hook | `mergeHookOutputs(outputs)` → 最严格的 `MergedHookOutcome` | （无） |
| 持久记录 | `appendHookInvoked` / `appendHookResult`（`hook/*` 会话事件；结果的 `decision`／`stderrSummary` 从此处的 `HookOutput` 派生） | 在每次调用前后调用它们 |
| 脱离运行完全停稳 | `createDetachedRuns()`：跟踪发射后不再等待的运行链；`drain()` 先 abort，再等待它们 | 将 `signal` 传给每个脱离的 `runHook`，并将 `drain` 注册为 effect disposer |

## 原语

- **`matchesMatcher(matcher, query, mode)`**：缺失、`''` 或 `'*'` 时匹配全部；`claude` 模式将纯 `[A-Za-z0-9_|]+` pattern 视为字面值（pipe = 精确匹配交替），其他 pattern 视为正则；`codex` 模式始终使用未锚定正则。无效正则不匹配任何内容（绝不抛出异常）。
- **`runHook(bash, hook, options, now)`**：要求并转发调用方拥有的 `options.signal`，将 `options.payload` 序列化到 hook stdin（当且仅当 `options.trailingNewline` 时添加尾随换行符），在执行器凭证清理后合并 `options.env`（`dsh-bash` 受信任插件表层），遵循 hook 的 `timeoutSec`（否则使用 `options.defaultTimeoutMs`；默认值属于桥接，其配置默认为 lib 的 `DEFAULT_HOOK_TIMEOUT_MS` 10 分钟参考值），再解码结果（将 `options.expectedEventName` 传递给 codec）。因此取消会到达执行器的进程组终止与 join 边界。它绝不抛出异常：执行器拒绝（基础设施故障）会变为 `HookOutput`，其 `exitCode: undefined`（非阻塞错误）。`now` 会被注入，以便测试持续时间。
- **`parseHookOutput(exitCode, stdout, stderr, expectedEventName?)`** 解码退出状态与结构化 stdout。退出码 2 使用 stderr 阻塞；其他失败不阻塞。匹配的 hook 特定权限决策会覆盖遗留顶层决策；事件判别字段不匹配或缺失只会抑制事件特定字段。顶层字段仍与事件无关，成功但非 JSON 的输出会留给桥接处理。
- **`mergeHookOutputs(outputs)`**：折叠在一个点上匹配的每个 hook 结果：权限优先级为 **deny > ask > allow**，首个 `continue:false` 使 halt 粘滞，阻塞原因用 `\n\n` 连接，`additionalContext`／`systemMessages` 按顺序累积。
- **`createDetachedRuns()`**：为脱离运行的 emit 形状点跟踪完全停稳（没有 seam 等待它们）。桥接会跟踪每条运行链，包括 hook 运行及其 continuation，并将 `drain()` 注册为 effect disposer。drain 会触发 tracker 的 abort `signal`（因此仍在运行的 hook 进程会通过 `runHook` 终止，而不是等待到超时），随后在所有已跟踪链结算后 resolve。因此 `fiber.dispose()` resolve 时，没有脱离 hook 工作会留下并触发已 dispose 的上下文（见 [防御模式](../../../docs/defensive-patterns.md)：dispose 必须达到完全停稳）。

## `hook/*` 会话事件

通过 declaration merging 合并到 `SessionEventMap`（仅日志，与 `compact/*` 相同；不是 `SurfaceEventType`，没有 `surfaceOp`）：`hook/invoked`（hook 命令已运行）与 `hook/result`（其结果，按 `handlerId` 配对，由 `appendHookResult` 拥有决策规则）。Payload 与每事件 JSDoc 位于生成的 [持久化日志事件目录](../../../docs/persistence-catalog.md)；`stderrSummary` 会截断到记录的 `stderrSummaryMaxChars`（桥接配置，参考默认值 `DEFAULT_STDERR_SUMMARY_MAX_CHARS` = 500；为空时省略）。

与每个事件一样，它们必须位于开启轮次内。轮次中点（`PreToolUse`／`PostToolUse`／`UserPromptSubmit`／`Stop`）按构造位于 loop 的开启轮次中；`SessionStart` 没有 `hook/*` 记录（其注入的 `user/message` 是持久证据），详见 hooks Agent Note。

## 模型体验

通过 `dsh-hooks-claude` 与 `dsh-hooks-codex` 间接影响；它们可以将解析后 hook 输出转为提示词上下文、已阻塞结果或 continuation 反馈。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **`HookOutput.updatedInput` 会被解析但不会应用**：输入改写是已暂缓的一致性设计问题（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)）；当 hook 设置它时，桥接会记录 + 警告。完整契约见 `src/types.ts`。
- **无效 matcher 正则会静默地不匹配任何内容**：`matchesMatcher` 绝不抛出异常；显示该错误需要返回诊断的变体或解析时验证（`TODO(matcher-diagnostics)`）。
