# @deepseek-ai/dsh-jsonrpc

The **SDK server plugin** (`jsonrpc`): mounting it serves a stdio JSON-RPC server that lets an out-of-process SDK client (e.g. the Python `deepseek_harness` package) drive DeepSeek Harness agents without touching Cordis. The client speaks newline-delimited JSON-RPC on the process stdin/stdout ([`HarnessSdkServer`](src/server.ts): `initialize` → `session/prompt` → `shutdown`, with `session.event` / `session.finished` / `subagent.*` notifications over [`JsonRpcLineTransport`](src/transport.ts)). The SDK-client analogue of the [`acp`](../acp/README.md) bridge, split the same way: this package is the protocol plugin, [`jsonrpc-agent`](../jsonrpc-agent/README.md) is the app bin that boots a `cordis.yml` around it — which process serves this protocol is a config decision, not a hardcoded bin. This plugin is the serving face of the single-exe distribution plan — see [docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../../../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).

## Wiring

`inject: ['agents']` — the server creates one agent per SDK `sessionId` (get-or-create on `session/prompt`) and demuxes `subagent/end` through the registry. The LLM seam is read opportunistically via `ctx.get('llm')` (not injected): when `initialize.model` has no registered adapter, the plugin mounts `dsh-llm-deepseek` for it (credentials from `$DEEPSEEK_API_KEY` / `$DEEPSEEK_BASE_URL`); a config-registered adapter for the model wins. Everything else — persistence, the tool stacks, the adapter set — comes from the surrounding `cordis.yml`.

## Config

No `cordis.yml`-settable keys. The `JsonRpcConfig` fields (`input`, `output`, `exit`) are runtime-only test seams so a spec can drive the server over in-memory streams without a subprocess or a killed test process; production always serves the process stdio and exits via `process.exit`.

## stdout is the protocol

The process stdout this plugin runs in carries only JSON-RPC frames. The tree that loads it must load NO stdout logger (a console logger corrupts the frames) — the guarantee is config-only, same as the ACP bridge. Diagnostics go to stderr.

## Shutdown and exit semantics

The plugin owns the PROTOCOL-level exit: a `shutdown` request is answered first (the response frame flushes), then the plugin disposes its own fiber — running the effect disposer: an idempotent `server.shutdown()` (every SDK-created agent disposed to quiescence, event subscriptions detached) plus `transport.close()` — and exits the process with code 0. Own-fiber disposal is deliberate: the request's `server.shutdown()` already flushed all SDK-owned session state, and the process exit that follows is the teardown of the rest of the tree. Process-level exits (stdin EOF → 0, SIGTERM → 0, SIGINT → 130) belong to the app bin, which disposes the whole root context. Fiber disposal WITHOUT a `shutdown` request (HMR-style unload) just stops serving — it never exits the process.

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime` (SDK clients key on it, independent of this package's name). A session accepts at most one in-flight `session/prompt`; an overlapping prompt for the same `sessionId` fails immediately through the standard handler-error response, while other sessions remain independent and the same session can be reused after the active prompt settles. Persistence roots and the deployment persona come from `cordis.yml`; the wire exposes only parameters the server applies.
