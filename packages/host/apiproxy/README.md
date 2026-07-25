# @deepseek-ai/dsh-host-apiproxy

The API gateway every client shape shares: the TS contract (`src/api/`, zero Node dependencies, importable from the browser), the fetch carrier pair (`src/fetch/`: `toFetchHandler` on the host side, `AbstractApiClient` plus platform subclasses on the client side), and the host-side implementation (`src/api-proxy.ts`: `createApiProxy` plus the default-exported `ApiProxyService` gateway plugin — config `{provider, model}`, provides `ctx.apiProxy`). Transport-agnostic by design: this package registers no routes; carriers (HTTP today, IPC later) wrap `ctx.apiProxy` themselves. The composition lives in `apps/cli/cordis.yml` (the `api-gateway` row).

## Contract layer (`/api`)

Wire messages form a four-quadrant discriminated union — who initiates × request/response — decoupled from the physical channel: `ClientRequest` (POST `/api/<method>` body), `ServerResponse` (that POST's response body), `ServerRequest` (SSE frame), `ClientResponse` (POST `/api/respond` body). Responses always echo the matching request's `rpcId` and never mint a new one. Method parameter/return structures live only in the domain interface signatures (`SessionsApi`, `HostApi`, `EventsApi`); `RpcMethodMap` registers the methods and every other position derives via `RequestPayload<K>`/`ResponseValue<K>`. Zod schemas anchor `satisfies z.ZodType<Wire<T>>` and parse at two levels: envelope first, business payload second, dispatched per method. Business errors ride `RpcResult`'s error branch (`RpcErrorDetailsMap` closes the code set); HTTP status expresses only the carrier.

The layering/protocol decisions are recorded in the [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md); the browser-side consumption architecture in the [web client architecture RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md).

The mux stream projects the latest log-backed title as a validated `session/title` control frame after each attached-session subscription baseline and immediately after the corresponding live raw title event. This projection does not add titles to `session.list`; cold sessions remain metadata-only there until opening or resuming attaches their logs.

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
