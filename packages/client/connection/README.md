# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer layer: the client plugin's apply mounts `ctx.connection` (shared api client + single-consumer stream-loop starter); the export face carries the wire contract types, the `AbstractApiClient` seam, and the loop's sink/config types. The platform subclasses (WebApiClient/FixtureApiClient), the ConnectionController loop, and the fixture data source are package-internal — apply selects and drives them; tests reach them via src. Contract: api-contracts v3 §3.

## /api browser-trust fence

The node half guards every request under `/api` before bridging (`src/api-request-trust.ts`). Requests without browser markers (no `Origin`, no `sec-fetch-site` — curl, tests, native clients) pass on any Host: without a browser there is no confused deputy, and such a sender forges every header anyway. For browser requests, the `Host` header must be a loopback authority or match a `trustedHosts` entry — exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization (DNS-rebinding defense); an attached `Origin` must equal that authority, and an explicit `sec-fetch-site: cross-site` marker is refused. A `trustedHosts` entry that is not a bare `host[:port]` authority fails the plugin load loudly — WHATWG parsing would otherwise quietly authorize the hostname inside a typo like `harness.internal/path`. Failures answer plain 403 before any RPC dispatch. A non-loopback (`--host 0.0.0.0`) deployment therefore needs its serving authorities trusted: the dsh CLI derives the machine's LAN IP literals itself and its `--trusted-host` flag declares named ones, so `trustedHosts` in cordis.yml is for compositions the CLI does not boot. The fence is deliberately not an authentication layer — reachability policy stays with the webserver binding, and auth remains deferred work. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

## Keyless fixture

Any `fixture` query parameter selects the in-memory carrier. `fixture=empty` starts with no Workspace or Session; `fixturePrompt=reject` rejects prompts before acceptance; `fixtureAttach=fail` publishes a Session but rejects its Workspace attachment; `fixtureSessionCreate=drop-response` publishes and frames a Session before dropping the create response; and `fixtureFrames=workspace-first` reverses the default session-first create-frame order. Workspace creation by name/path and caller-preallocated SessionIds remain deterministic enough for assembled Web tests to reconcile list and frame arrival.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **history's implicit resume is arguable** — opening history on an unattached session pulls an agent up host-side; the pure-persistence-read alternative is recorded in the rt-core reconciliation ledger, unchanged in P-I. This package's consumers see it as latency on first open.
- **`ToolEventView`/`ToolCallView`/`ToolResultView` re-exports are scheduled for removal** — they fall when the toolview migration deletes the host `viewFor` line (presentation belongs to the client); the fixture keeps a local `viewFor` mirror until then.
