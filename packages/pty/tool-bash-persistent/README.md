# @deepseek-ai/dsh-tool-bash-persistent

English | [中文](README.zh.md)

Model-facing `bash(command)` backed by one owner-scoped `ctx.pty` shell. The package owns the tool contract and shell reuse; deployments select the PTY backend and sandbox policy.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `backendType` | `shell` | Registered PTY backend used for each Agent shell. |
| `timeoutMs` | `300000` | Wall-clock limit for one command; timeout closes the shell. |
| `maxOutputChars` | `16000` | Prefix characters retained before the clipping notice. |
| `description` | Persistent-shell description | Model-facing environment contract. |

## Model Experience

### Tool schema

#### What the model sees

The generated [`bash` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bash-persistent), including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while `bash` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, exported variables, activated environments, functions, and background jobs persist across calls. Results exclude private completion markers and the shell prompt. Long output keeps the earliest retained prefix plus a clipping notice. If the PTY has already dropped that prefix, the result says so explicitly instead of presenting a tail as complete output. Timeout returns bounded partial output, closes the uncertain shell, and tells the model that the next call starts fresh.

#### Token effect

Data-dependent and bounded by `maxOutputChars` plus the fixed clipping notice.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

- The tool requires an owning Agent and a real PTY backend.
- Explicit `exit`, timeout, or cancellation discards shell state; the next call starts a fresh shell.
- Environment facts such as network access and package mirrors belong in the configured `description`, not this package's default.
