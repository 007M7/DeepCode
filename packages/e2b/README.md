# e2b/ — E2B remote runtime family

English | [中文](README.zh.md)

An experimental provider-composition POC that places the mutable coding world in one E2B Linux sandbox. The shared owner is separate from capability adapters so every remote provider awaits the same sandbox identity and lifecycle.

| Package | ctx key | Role |
|---|---|---|
| [`e2b`](e2b/README.md) (`@deepseek-ai/dsh-e2b`) | `ctx.e2b` | Create or reconnect one sandbox, create its working/runtime directories, expose the shared SDK handle, and apply the configured kill/pause/leave disposition |
| [`fs-e2b`](../fs/fs-e2b/README.md) (`@deepseek-ai/dsh-fs-e2b`) | `ctx.fs` | Implement the filesystem seam over E2B Filesystem APIs |
| [`subprocess-e2b`](../subprocess/subprocess-e2b/README.md) (`@deepseek-ai/dsh-subprocess-e2b`) | `ctx.subprocess` | Implement managed process groups, stdio projection, and remote spill files over E2B Commands |
| [`pty-e2b`](../pty/pty-e2b/README.md) (`@deepseek-ai/dsh-pty-e2b`) | `ctx.pty` backend | Run persistent interactive shells through E2B's byte PTY API |
| [`lsp-e2b`](../lsp/lsp-e2b/README.md) (`@deepseek-ai/dsh-lsp-e2b`) | `ctx.lsp` provider | Run configured language servers and read query sources inside E2B |
| [`code-runtime-e2b`](../code-runtime/code-runtime-e2b/README.md) (`@deepseek-ai/dsh-code-runtime-e2b`) | `ctx.codeRuntime` | Run model-written programs remotely while bridging bindings to the host |

The existing [`dsh-bash-local`](../bash/bash-local/README.md) needs no E2B-specific fork: it delegates process mechanics to `ctx.subprocess`, so replacing that provider places Bash in the same remote world. This boundary does not move the harness process, Cordis objects, model calls, agent/session state, session persistence, skills, protocol state, or E2B SDK buffers. The [base decision](../../.agents/notes/implemented/feature/2026-07-27-e2b-remote-runtime-poc.md) and [runtime-extension decision](../../.agents/notes/implemented/feature/2026-07-28-e2b-interactive-semantic-code-runtime-poc.md) own the POC boundary.
