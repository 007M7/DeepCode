# @deepseek-ai/dsh-lsp-e2b

English | [中文](README.zh.md)

Generic E2B language-server backend for [`ctx.lsp`](../lsp/README.md). It runs configured stdio servers and reads their source documents inside the shared `ctx.e2b` sandbox; the provider registry, normalized query results, queues, and protocol connection state remain on the host.

## Plugin and configuration

The `lsp-e2b` plugin injects `e2b`, `lsp`, and the concrete `dsh-subprocess-e2b` service. `servers` is a non-empty provider-id table:

| Server key | Default | Meaning |
|---|---|---|
| `command` | required | Remote executable, absolute or resolved on the sandbox PATH at load. |
| `args` | `[]` | Remote server arguments. |
| `env` | `{}` | Explicit environment entries passed through the subprocess adapter. |
| `extensionToLanguage` | required | Lowercase leading-dot extension to LSP language id. |
| `initializationOptions` / `configuration` | `null` / `null` | Static initialize options and `workspace/configuration` answer. |
| `maxMessageBytes` | `16000000` | Largest LSP message accepted from the server. |
| `maxStderrBytes` | `1000000` | Retained raw server stderr tail. |
| `maxDocumentBytes` | `4000000` | Largest remote source opened for one query. |
| `shutdownTimeoutMs` | `5000` | Graceful protocol-shutdown budget. |
| `killGraceMs` | `2000` | Request-cancel and TERM-to-KILL grace. |

Provider ids and commands are non-empty; numeric bounds are positive safe integers, and timer values cannot exceed Node's maximum timer delay. Setup uploads one owner-private proxy under `ctx.e2b.runtimeRoot`, resolves Node and every configured server executable remotely, then registers all providers atomically.

## Remote protocol and filesystem

E2B command callbacks are text, while LSP is byte-framed. The installed proxy therefore base64-frames raw server stdout, stderr, and stdin as newline-delimited ASCII JSON; the host validates and decodes every frame before handing bytes to the shared `LspInstance` protocol engine. `initialize.processId` is `null` because host and server do not share a process namespace.

One language-server process is pooled per provider and canonical remote workspace. Queries serialize per workspace but different workspaces run concurrently. Each query canonicalizes the remote workspace and source with `realpath`, rejects paths outside that workspace, requires a regular file, enforces the size bound before and after reading, decodes strict UTF-8, and uses the ordinary transient `didOpen` / request / `didClose` lifecycle. A transport failure disposes the instance and retries the read-only query once on a fresh remote process.

The subprocess adapter owns process groups and escalation, so cancellation and disposal await remote server quiescence. The host owns LSP request ids, pending requests, provider queues, and normalized results.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-lsp`, which exposes normalized semantic navigation and hover results without changing its model-facing schema.

#### KV Cache effect

No direct invalidation; `dsh-tool-lsp` owns request-prefix changes.

## Known Limitations and Deferred Work

- **Configured servers only** — this package does not install language servers, select presets, or synchronize a host workspace into E2B.
- **Host protocol state is not reconnectable** — retaining a sandbox does not restore provider queues, JSON-RPC requests, subprocess handles, or document lifecycle state.
- **SDK output retention remains** — ASCII framing preserves protocol bytes, but E2B and the subprocess adapter still retain callback output in host memory.
- **Sandbox policy is template-owned** — this provider adds no volume, snapshot, credential, or network-policy layer.
