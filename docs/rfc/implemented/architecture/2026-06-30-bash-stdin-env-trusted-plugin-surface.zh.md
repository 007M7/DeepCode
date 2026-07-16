# RFC：bash seam 上的 stdin 与额外 env

Status: implemented

[English](2026-06-30-bash-stdin-env-trusted-plugin-surface.md) | 中文

## 问题

钩子子系统运行外部钩子命令的方式与 Claude Code 和 Codex 相同：一个钩子就是一条 shell 命令，通过 **stdin 上的 JSON** 接收事件载荷，并从若干**环境变量**（`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`PLUGIN_ROOT`……）读取上下文。harness 在 `ctx.bash` 能力 seam 背后已经有一个完善的命令运行器（[dsh-bash](../../../../packages/bash/bash) → [dsh-bash-local](../../../../packages/bash/bash-local)），具备进程组 kill、输出截断/溢出处理和凭证擦除。将它复用于钩子执行，意味着钩子桥接层无需重新实现子进程管道——但该 seam 此前没有写入 stdin 或设置额外 env 的能力。本 RFC 添加这两项输入。

`stdin` 和 `env` 不构成新的模型能力，因为普通 shell 语法已经能提供这两者。环境中的凭证由 `dsh-bash-local` 的子进程环境擦除机制保护，而非靠隐藏这些 seam 字段；模型工具参数是静态 JSON，不会展开 shell 变量。因此这些字段服务于受信的进程内调用方（如钩子桥接层），它们需要传递结构化输入和 `CLAUDE_*` 变量，而不必将其嵌入模型可见的 shell 文本。环境变量规则见 [defensive-patterns.md](../../../defensive-patterns.md)。

## 决策

在 `BashExecRequest`（面向模型/插件的请求）和 `BashExecSpec`（`run`/`start` 实际执行的解析后规格）上**同时**添加 `stdin?: string` 与 `env?: Record<string, string>`，并在 `dsh-bash-local` 中贯穿：`resolve()` 原样传递，`run()`/`start()` 将它们传给 `runBash`，后者把字节写入子进程的 stdin 并合并额外 env。

三个刻意的选择：

1. **面向模型的工具不暴露 `stdin` 和 `env`。** Shell 语法已经覆盖这些需求，重复的参数只会增加接口面而不带来权限隔离。工具仅从声明的模型参数、signal 和 owner 构建请求；受信的进程内调用方可以直接设置 seam 字段。

2. **`env` 在凭证擦除之后合并，因此调用方显式设置的条目总是胜出**——即使名称看起来像凭证。这是正确的，因为擦除的职责很窄：阻止 harness 自身 *ambient* `process.env` 中的凭证泄漏到子命令中。调用方显式设置一个变量时，它命名的是自己已持有的值（而非 ambient 密钥），因此擦除不是对它的约束。`childEnv(extra?)` 的分层为 `scrub(process.env)` → `ENV_OVERRIDES`（面向模型的 `TERM=dumb` 等）→ `extra`，后者优先。

3. **`stdin`/`env` 在解析后规格上是 required-absent-OK（普通 optional），而非像 `owner` 那样 required-but-nullable。** `owner` 之所以是 required-but-nullable，是因为*静默*缺失的 owner 会产生一个无主的、跨会话可读的任务——这是一个安全隐患，显式的 `undefined` 可以防范。`stdin`/`env` 没有这种风险：缺失意味着「无 stdin / 无额外 env」，这是安全的常规情况（所有模型驱动的调用都如此）。因此它们保持普通 optional，与 `signal` 一致。

`dsh-bash-local` 仅在提供了字节时才创建 stdin 管道；否则 fd 0 保持 `/dev/null`，维持原有行为。它写入字节后关闭管道。如果子进程未读取就退出导致 `EPIPE`，则忽略该错误，因为命令退出状态和输出决定结果。

## 曾考虑的替代方案

**可配置的 ambient 密钥擦除。** 否决，属于推测性需求。受信调用方可以在擦除之后显式提供所需值，无需削弱默认的 ambient 保护。

## 后果

钩子桥接层通过既有的 bash seam 传递 JSON 载荷和钩子专属变量，保留其进程组管理、截断和溢出行为。模型接口面不变，bash 工具仍是模型调用请求构建的唯一入口。相关词汇定义见 [bash 数据结构参考](../../../core-data-structures/bash.md)。
