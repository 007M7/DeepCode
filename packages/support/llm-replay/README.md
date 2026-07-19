# @deepseek-ai/dsh-llm-replay

A replay LLM plugin for keyless snapshot tests. It yields model streams reconstructed from a recorded **session JSONL** fixture, so a test can boot the real agent against a fixed model transcript with no API key. With `providers` configured it registers a replay-only adapter whose catalog is visible to clients such as ACP editors; without `providers` it installs the catch-all `llm/stream` waterfall used by tests that do not need discovery.

Its consumers are the ACP snapshot harness in `examples/acp-agent` and the `stream-json` snapshot in `examples/headless-agent`; each loads this plugin in place of a real LLM adapter. Keeping derivation and replay here places that logic under the per-file 100% coverage gate on `packages/*/src`.

## How the fixture works

The fixture IS the persisted session log (`<scenario>/session.jsonl`). Its `assistant/chunk` events carry every `StreamChunk`, so grouping them by `(turn, step)` reconstructs each `stream()` call's chunk sequence (one model call per loop step). Recording is therefore "run the real agent once and harvest the `.jsonl`", done by the snapshot harness — this plugin does not record. A fixture may carry its `request/header` content tokenized to `{{system}}`/`{{tools}}` (the harness pins that content in one scenario and scrubs the rest); replay is indifferent — derivation reads only `assistant/chunk` events and the line-0 session header.

Two failure modes are not reconstructable from `assistant/chunk` alone — a pure throw before any chunk (e.g. an HTTP 401, where the log holds only a `turn/end {error}` and no chunks) and a cancel/hang (timing, not chunk content). A scenario that needs those supplies an optional sidecar (`<scenario>/replay.override.json`: a `ReplayEntry[]`) that REPLACES the derived script.

## Nested agents: per-session keying

A scenario where a parent agent delegates to in-process subagents records more than one log: the parent (`session.jsonl`) plus one per child (`session.1.jsonl`, …). Each agent runs as its own `Session` on the same context, so replay must serve each one its own script.

Replay keys every call by its calling session id (`GenerateOptions.sessionId`, stamped by the agent loop). Live session ids are freshly random each run and never equal the recorded ones, so a live session binds to a recorded script by **first-call order**: scripts are ordered by header `createdAt` (parent first — it streams before it can delegate), and the first live session to make any call claims the first script, the next new session the next, and so on. Each session then advances its own cursor. A call with no `sessionId` is one anonymous session bound to the primary script, so single-session scenarios behave exactly as before. More distinct live sessions than recorded scripts fails loud.

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `file` | string | `$DSH_SNAPSHOT_FILE` | Path to the primary (parent) `session.jsonl` fixture. Required (config or env). |
| `overrideFile` | string | `$DSH_SNAPSHOT_OVERRIDE` | Optional path to a `ReplayEntry[]` sidecar that replaces the PRIMARY session's derived script. |
| `childFiles` | string[] | `$DSH_SNAPSHOT_CHILD_FILES` (path-delimited) | Recorded subagent child-session logs for a nested scenario; empty for a single-session scenario. |
| `providers` | `ReplayProviderConfig[]` | — | Optional replay-only provider and model catalog. Configured routes dispatch through the replay adapter and never perform provider I/O. |

```yaml
- id: llm-replay
  name: '@deepseek-ai/dsh-llm-replay'
  config:
    providers:
      - id: deepseek
        name: DeepSeek
        models:
          - id: deepseek-v4-flash
          - id: deepseek-v4-pro
  # file/overrideFile/childFiles default to $DSH_SNAPSHOT_FILE /
  # $DSH_SNAPSHOT_OVERRIDE / $DSH_SNAPSHOT_CHILD_FILES, set by the snapshot
  # harness per scenario.
```

## Exports

- `installLlmReplay(ctx, config)` — install the configured replay adapter or catch-all `llm/stream` listener; returns the disposer (HMR safety). Use this in tests to drive replay without the Loader or env vars.
- `loadSessionScripts(config)` — resolve the ordered `SessionScript[]` (primary + children) for a scenario, ready to bind to live sessions in first-call order.
- `loadReplayScript(config)` — resolve the `ReplayEntry[]` for the PRIMARY session only (sidecar override if present, else derived from the JSONL; fail-loud if the fixture is missing).
- `deriveReplayScript(events)` / `parseSessionLog(text)` / `parseSessionHeader(text)` — the pure helpers that turn a recorded session log into a script and read its header `id`/`createdAt`. A derived group must end in a `finish` chunk; a group without one is the fingerprint of a thrown `stream()` and must instead be expressed via an override sidecar.
- Types `ReplayEntry` / `SessionScript` / `ReplayConfig` / `ReplayProviderConfig` / `ReplayModelConfig` / `Config`.

## Plugin export shape

Named `name` / `inject` / `Config` / `apply`, with **no default export**: the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default would collapse the module to the bare function and drop the `inject` namespace (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

None, as this keyless test adapter sends no request to a provider model; it only replays recorded assistant chunks into the test loop.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **First-call-order script binding assumes sequential delegation** — a cut that runs sibling subagents concurrently (or a compaction summarize call landing mid-run) would bind live sessions to recorded scripts non-deterministically; a stronger keying is deferred until such a scenario exists (`XXX(concurrent-subagents)`).
- **Only chunk-producing calls are derivable** — a pure pre-chunk throw or a cancel/hang scenario needs the `replay.override.json` sidecar; the override replaces the PRIMARY session's script only.
