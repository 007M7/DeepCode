# @deepseek-ai/dsh-jsonrpc

Stdio JSON-RPC plugin for out-of-process SDK clients such as Python `deepseek_harness`. [`HarnessSdkServer`](src/server.ts) handles `initialize` → `session/prompt` → `shutdown` plus session and subagent notifications over [`JsonRpcLineTransport`](src/transport.ts). This package owns the protocol; [`jsonrpc-agent`](../../examples/jsonrpc-demo/README.md) boots the external `cordis.yml` that chooses the surrounding runtime. See the [single-executable RFC](../../../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) for the distribution design.

## Wiring

`inject: ['agents']`. The server gets or creates one agent per `sessionId` on `session/prompt` and demuxes `subagent/end` through the registry. If `initialize.model` lacks a registered adapter, it mounts `dsh-llm-deepseek` using `$DEEPSEEK_API_KEY` and `$DEEPSEEK_BASE_URL`; a config-registered adapter wins. Persistence, tools, and other adapters come from the surrounding `cordis.yml`.

## Config

No `cordis.yml` keys. `JsonRpcConfig.input`, `output`, and `exit` are test-only runtime seams; production uses process stdio and `process.exit`.

## stdout is the protocol

stdout carries only JSON-RPC frames. The loading config must omit stdout loggers; diagnostics go to stderr.

## Shutdown and exit semantics

A `shutdown` request flushes its response, disposes the plugin fiber, then exits 0. Disposal idempotently shuts down every SDK-created agent to quiescence, detaches subscriptions, and closes the transport. Bare fiber disposal only stops serving; it does not exit. The app bin owns root disposal for stdin EOF (0), SIGTERM (0), and SIGINT (130).

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. Each session permits one in-flight prompt; overlap fails immediately, other sessions remain independent, and the session is reusable after settlement. Persistence roots and deployment persona remain in `cordis.yml`.

## Model Experience

### SDK user message

**What the model sees**: For each accepted `session/prompt`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message in that SDK session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

**Token effect**: Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

## Known Limitations and Deferred Work

- **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown, and one accepted prompt runs to agent idle before that session accepts another.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
