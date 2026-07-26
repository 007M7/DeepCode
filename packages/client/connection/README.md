# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer layer: the client plugin's apply mounts `ctx.connection` (shared api client + single-consumer stream-loop starter); the export face carries the wire contract types, the `AbstractApiClient` seam, and the loop's sink/config types. The platform subclasses (WebApiClient/FixtureApiClient), the ConnectionController loop, and the fixture data source are package-internal — apply selects and drives them; tests reach them via src. Contract: api-contracts v3 §3.

## Keyless fixture

Any `fixture` query parameter selects the in-memory carrier. `fixture=empty` starts with no Workspace or Session; `fixturePrompt=reject` rejects prompts before acceptance; `fixtureAttach=fail` publishes a Session but rejects its Workspace attachment; `fixtureSessionCreate=drop-response` publishes and frames a Session before dropping the create response; and `fixtureFrames=workspace-first` reverses the default session-first create-frame order. Workspace creation by name/path and caller-preallocated SessionIds remain deterministic enough for assembled Web tests to reconcile list and frame arrival.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **history's implicit resume is arguable** — opening history on an unattached session pulls an agent up host-side; the pure-persistence-read alternative is recorded in the rt-core reconciliation ledger, unchanged in P-I. This package's consumers see it as latency on first open.
- **`ToolEventView`/`ToolCallView`/`ToolResultView` re-exports are scheduled for removal** — they fall when the toolview migration deletes the host `viewFor` line (presentation belongs to the client); the fixture keeps a local `viewFor` mirror until then.
