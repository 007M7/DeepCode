# @deepseek-ai/dsh-client-connection

Wire consumer layer (moved verbatim from web-runtime): IApiClient family (WebApiClient/FixtureApiClient), ConnectionController (SSE dual-stream + backoff reconnect), WEB_EVENTS. Contract: api-contracts v3 §3, export inventory in §3.2.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **history's implicit resume is arguable** — opening history on an unattached session pulls an agent up host-side; the pure-persistence-read alternative is recorded in the rt-core reconciliation ledger, unchanged in P-I. This package's consumers see it as latency on first open.
- **`ToolEventView`/`ToolCallView`/`ToolResultView` re-exports are scheduled for removal** — they fall when the toolview migration deletes the host `viewFor` line (presentation belongs to the client); the fixture keeps a local `viewFor` mirror until then.
