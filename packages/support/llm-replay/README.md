# @deepseek-ai/dsh-llm-replay

A replay LLM plugin for keyless snapshot tests. It installs a single `llm/stream` waterfall listener that short-circuits the waterfall (never calls `next()`) and yields model streams reconstructed from a recorded **session JSONL** fixture — so a test can boot the real agent against a fixed model transcript with no API key.

Its consumer is the ACP snapshot harness in `examples/acp-agent`, which loads this plugin (via `cordis.snapshot.yml`) in place of a real LLM adapter. The package exists so its derive/parse/replay logic falls under the per-file 100% coverage gate on `packages/*/src` (the same logic, while it lived under `examples/`, was outside the gate).

## How the fixture works

The fixture IS the persisted session log (`<scenario>/session.jsonl`). Its `assistant/chunk` events carry every `StreamChunk`, so grouping them by `(turn, step)` reconstructs each `stream()` call's chunk sequence (one model call per loop step). Recording is therefore "run the real agent once and harvest the `.jsonl`", done by the snapshot harness — this plugin does not record.

Two failure modes are not reconstructable from `assistant/chunk` alone — a pure throw before any chunk (e.g. an HTTP 401, where the log holds only a `turn/end {error}` and no chunks) and a cancel/hang (timing, not chunk content). A scenario that needs those supplies an optional sidecar (`<scenario>/replay.override.json`: a `ReplayEntry[]`) that REPLACES the derived script.

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `file` | string | `$DSH_SNAPSHOT_FILE` | Path to the per-scenario `session.jsonl` fixture. Required (config or env). |
| `overrideFile` | string | `$DSH_SNAPSHOT_OVERRIDE` | Optional path to a `ReplayEntry[]` sidecar that replaces the derived script. |

```yaml
- id: llm-replay
  name: '@deepseek-ai/dsh-llm-replay'
  # file/overrideFile default to $DSH_SNAPSHOT_FILE / $DSH_SNAPSHOT_OVERRIDE,
  # set by the snapshot harness per scenario.
```

## Exports

- `installLlmReplay(ctx, config)` — install the `llm/stream` listener; returns the disposer (HMR safety). Use this in tests to drive replay without the Loader or env vars.
- `loadReplayScript(config)` — resolve the `ReplayEntry[]` for a scenario (sidecar override if present, else derived from the JSONL; fail-loud if the fixture is missing).
- `deriveReplayScript(events)` / `parseSessionLog(text)` — the pure helpers that turn a recorded session log into a script. A derived group must end in a `finish` chunk; a group without one is the fingerprint of a thrown `stream()` and must instead be expressed via an override sidecar.
- Types `ReplayEntry` / `ReplayConfig` / `Config`.

## Plugin export shape

Named `name` / `inject` / `Config` / `apply`, with **no default export**: the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default would collapse the module to the bare function and drop the `inject` namespace (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).
