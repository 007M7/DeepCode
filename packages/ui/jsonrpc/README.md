# @deepseek-ai/dsh-jsonrpc

English | [中文](README.zh.md)

The `jsonrpc` plugin serves newline-delimited JSON-RPC over stdio so out-of-process SDK clients can drive harness agents. [`HarnessSdkServer`](src/server.ts) owns the protocol methods and notifications; the transport and the named wire types live in [`dsh-sdk-protocol`](../../sdk/sdk-protocol/README.md), shared with the client SDKs; [`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) supplies the surrounding `cordis.yml` application.

## Wiring

`inject: ['agents']`. The server gets or creates one agent per `sessionId`. It forwards subagent completions only when the service-snapshotted lifecycle `local` flag is true; provider names, child ids, and durable lineage never establish locality. A registered adapter wins, an unowned `deepseek-official` route mounts `dsh-llm-deepseek`, and any other unowned provider fails initialization. Other capabilities come from the surrounding `cordis.yml`.

## Config

`maxTokensAsSuccess` defaults to `false`. Set it to `true` for evaluation hosts that distinguish an accepted, token-limited agent result from an infrastructure failure. `JsonRpcConfig.input`, `output`, and `exit` are runtime-only transport seams; production uses process stdio and `process.exit`.

## stdout is the protocol

Stdout carries only JSON-RPC frames. The deployment must not compose a stdout logger; diagnostics belong on stderr.

## Shutdown and exit semantics

The plugin answers `shutdown`, disposes SDK-owned agents and subscriptions to quiescence, closes the transport, then exits with code 0. EOF and signal exits belong to the app bin, which disposes the root context. Unloading only this plugin stops serving without exiting the process.

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. An optional positive `initialize.maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants; invalid values reject initialization, while omission sends no SDK cap and allows the selected adapter or provider route default to apply. A session accepts one in-flight prompt; overlap fails immediately, other sessions remain independent, and the session is reusable after settlement. `session.finished` reports that prompt's message-triggered turn outcome; later between-turn records still stream as `session.event` notifications but cannot replace the prompt status. Persistence roots and persona come from `cordis.yml`.

## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message in that SDK session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown, and one accepted prompt runs to agent idle before that session accepts another.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
