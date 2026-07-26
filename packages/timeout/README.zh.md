# timeout/：工具调用超时策略

[English](README.md) | 中文

工具调用超时策略插件。它是单一 **产品** 包（package）：它是 `tools/execute` 环绕分发 seam（由 [`dsh-tools`](../core/tools) 拥有）和纯 [`dsh-timeout`](../util/timeout) 库的部署策略消费方，而非带接口／实现拆分的可替换能力，因此无需 seam 三包组合。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `timeout-policy/` | `tools/execute` 包装层：对每个已配置工具，它都在 `exec.signal` 上启动单次调用截止时间，并在截止时间先到时返回结构化 `TOOL_TIMEOUT` 结果 | （注册 `tools/execute` 监听器；不注入任何内容） |

超时被拆分为三层：[`dsh-timeout`](../util/timeout) 拥有纯计时／分类原语（`deadline`/`timeoutOf`）；每种能力拥有终止操作（bash 终止其进程组，fetch 提供方关闭其 socket）；本包则拥有 *作为部署策略的面向模型工具调用预算*：没有面向模型的超时参数，也没有全局默认值。它是[超时库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) 所预见的中间件。`bash` 和钩子命令执行保留各自的 `BASH_TIMEOUT` 后端超时，不经过此策略。
