# @deepseek-ai/dsh-host-apiproxy

English | [中文](README.zh.md)

The API gateway every client shape shares: the TS contract (`src/api/`, zero Node dependencies, importable from the browser), the fetch carrier pair (`src/fetch/`: `toFetchHandler` on the host side, `AbstractApiClient` plus platform subclasses on the client side), and the host-side implementation (`src/api-proxy.ts`: `createApiProxy` plus the default-exported `ApiProxyService` gateway plugin — config `{provider, model, workspaceRoot?}`, provides `ctx.apiProxy`). Transport-agnostic by design: this package registers no routes; carriers (HTTP today, IPC later) wrap `ctx.apiProxy` themselves. The shipped core composition lives in [`apps/cli/cordis.yml`](../../../apps/cli/cordis.yml).

## Contract layer (`/api`)

Wire messages form a four-quadrant discriminated union — who initiates × request/response — decoupled from the physical channel: `ClientRequest` (POST `/api/<method>` body), `ServerResponse` (that POST's response body), `ServerRequest` (SSE frame), `ClientResponse` (POST `/api/respond` body). Responses always echo the matching request's `rpcId` and never mint a new one. Method parameter/return structures live only in the domain interface signatures (`SessionsApi`, `HostApi`, `EventsApi`); `RpcMethodMap` registers the methods and every other position derives via `RequestPayload<K>`/`ResponseValue<K>`. Zod schemas anchor `satisfies z.ZodType<Wire<T>>` and parse at two levels: envelope first, business payload second, dispatched per method. Business errors ride `RpcResult`'s error branch (`RpcErrorDetailsMap` closes the code set); HTTP status expresses only the carrier.

The layering/protocol decisions are recorded in the [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md); the browser-side consumption architecture in the [web client architecture RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md).

The mux stream projects the latest log-backed title as a validated `session/title` control frame after each attached-session subscription baseline and immediately after the corresponding live raw title event. This projection does not add titles to `session.list`; cold sessions remain metadata-only there until opening or resuming attaches their logs.

Session model routing is a session-domain contract. `session.models` returns the selected provider/model/reasoning target with provider-grouped advisory models, exact-route reasoning metadata, and provider-local lookup failures. `session.selectModel` validates the optional adapter-owned reasoning effort and replaces the complete target selected for the next prompt-assembly boundary. Catalog membership is not validation: an adapter may resolve an unlisted model, while an unavailable route or unsupported effort returns `model-unavailable`.

Workspace and Session lists are separate reconnect baselines. `workspace.create` creates a unique name or adopts an existing directory, `workspace.delete` removes only the Workspace registration, `session.create` accepts an optional preallocated Session id, and `host/workspace-changed`, `host/workspace-removed`, plus `host/session-added` carry committed increments in either arrival order. Registration deletion preserves the directory and session logs; its Sessions remain in `session.list` and become Ungrouped. `SessionSummary.blank` and the `host/session-added` frame carry the derived zero-events bit: clients hide blank sessions and reuse them per workspace, flip blank on the first `host/session-status(running:true)`, and treat `session.list` as the reconnect authority; cold summaries are never blank because lazy persistence keeps never-appended sessions out of `list()`.

`host.pickDirectory` opens one native directory picker and returns its selected path, or `null` when the user cancels. Its host implementation invokes platform tools without a shell: `osascript` on macOS, an STA PowerShell `FolderBrowserDialog` on Windows, and Zenity with a KDialog fallback on Linux. The picker function is injectable for tests. This user-paced method is the sole unary call exempt from the default 30-second timeout; caller and connection aborts still propagate to the native process. The browser carrier separately restricts this privileged method to loopback, same-origin requests.

`session.history` pages on message boundaries, and its tail page (no `beforeSeq`) carries two session-level extras the page window cannot supply: the in-flight partial's chunk events, and `todos` — the latest `todo/write` whole-list projection over the full log. Older pages omit `todos` because the projection is session-level, not per-page; a tail response that omits it means the whole log holds no `todo/write`, so clients read the absent field as the empty plan rather than as unchanged state.

The `command.*` and `skill.*` domains expose the host command registry and skill catalog to clients. Every method addresses one session's agent by `sessionId` (a served session always has an Agent; `command.*` resumes cold sessions through the same path as `session.*`, while `skill.list` resolves the project root from the session header without touching the Agent registry). `command.execute` runs a slash-command line host-side and returns a detached result; the carrier's request signal cancels the running handler. `host/commands-changed` is the catalog invalidation frame: clients refetch `command.list` instead of diffing.

## Carrier layer (`/client` + root)

`AbstractApiClient` holds every protocol invariant — rpcId minting, envelope wrap/unwrap, zod parsing, SSE frame decoding, unary timeout, microtask-batched envelope observation (`subscribeEnvelopes`) — while platform subclasses supply only the `doFetch` transport aspect. `InProcessApiClient` over `toFetchHandler(api)` is the isomorphic point: the full wire serialization/validation path with no network, used by `dsh -p` headless.

## Model Experience

None, as the package defines the client↔host wire contract and carriers; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`respond` routing is shipped, but pending-interaction state is host-side work** — the wire shape (POST `/api/respond`, `RpcReceipt`) is final; the pending table that makes late/duplicate answers meaningful lives in `src/api-proxy.ts` and is still minimal (questions only, no approvals).
- **Reserved seams stay out of `RpcMethodMap`** — `session.fork`, `prompt.mode: 'inject'`, `task.list`, `host.listModels`, and a describe `hostInstanceId` are documented reservations; an unknown method fails loud at envelope parse rather than getting a not-implemented code.
- **No protocol version field** — client and host ship together; `host.describe` gains a version negotiation field only when an independently released client exists.
- **Linux native picker requires desktop tooling** — `host.pickDirectory` reports an actionable error when neither Zenity nor KDialog is installed; it does not fall back to a custom or typed-path browser.
