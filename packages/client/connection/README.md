# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer layer: the client plugin's apply mounts `ctx.connection` (shared api client + single-consumer stream-loop starter); the export face carries the wire contract types, the `AbstractApiClient` seam, and the loop's sink/config types. The node half's `/api` route pins the privileged method set (`host.pickDirectory`, `host.openPath`, and the whole configuration plane — `settings.describe`/`update`/`replace`/`mutate` and `credentials.describe`/`set`/`unset`, reads included, since describing returns the exposed configuration and probing an arbitrary reference reports where a credential comes from) to loopback by passing the trust fence with an empty trust list — a declared `trustedHosts` authority reaches every other method, while these stay loopback-local until a real authentication layer exists. The platform subclasses (WebApiClient/FixtureApiClient), the ConnectionController loop, and the fixture data source are package-internal — apply selects and drives them; tests reach them via src. Contract: api-contracts v3 §3.

## /api browser-trust fence

The node half guards every request under `/api` before bridging (`src/api-request-trust.ts`). Every request — browser-marked or not — must present a `Host` that is a loopback authority or matches a `trustedHosts` entry: exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization (DNS-rebinding defense). There is deliberately no shortcut for requests without browser markers: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to reads (EventSource, images, navigations — those headers go only to trustworthy destinations), so an unmarked request may still be a rebound browser read with a readable response, and Host is the one header rebinding cannot forge; non-browser clients pass the same fence via loopback, the CLI-derived LAN IP literals, or a declared authority. When markers are present, an attached `Origin` must equal the Host authority, and an explicit `sec-fetch-site: cross-site` marker is refused. A `trustedHosts` entry that is not a bare, canonical `host[:port]` authority — one WHATWG parsing reads back exactly as written — fails the plugin load loudly: parsing would otherwise quietly authorize the hostname inside `harness.internal/path`, or broaden a dangling-colon or zero-padded port to an any-port grant. Failures answer plain 403 before any RPC dispatch. A non-loopback (`--host 0.0.0.0`) deployment therefore needs its serving authorities trusted: the dsh CLI derives the machine's LAN IP literals itself and its `--trusted-host` flag declares named ones, so `trustedHosts` in cordis.yml is for compositions the CLI does not boot. The fence is deliberately not an authentication layer — reachability policy stays with the webserver binding, and auth remains deferred work. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).

## Keyless fixture

Any `fixture` query parameter selects the in-memory carrier. `fixture=empty` starts with no Workspace or Session; `fixturePrompt=reject` rejects prompts before acceptance; `fixtureAttach=fail` publishes a Session but rejects its Workspace attachment; `fixtureSessionCreate=drop-response` publishes and frames a Session before dropping the create response; and `fixtureFrames=workspace-first` reverses the default session-first create-frame order. Workspace creation by name/path and caller-preallocated SessionIds remain deterministic enough for assembled Web tests to reconcile list and frame arrival.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **history's implicit resume is arguable** — opening history on an unattached session pulls an agent up host-side; the pure-persistence-read alternative is recorded in the rt-core reconciliation ledger, unchanged in P-I. This package's consumers see it as latency on first open.
- **`ToolEventView`/`ToolCallView`/`ToolResultView` re-exports are scheduled for removal** — they fall when the toolview migration deletes the host `viewFor` line (presentation belongs to the client); the fixture keeps a local `viewFor` mirror until then.
