# RFC: ACP snapshot tests — record-once / replay-deterministic

Status: implemented (accepted 2026-06-19)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The harness has two test tiers: keyless unit `.spec.ts` (the 100%-per-file coverage gate) and real-API `.e2e.ts` (key-gated, self-skipping in CI). Neither continuously verifies the **complete output transcript** an ACP editor (Zed) sees on its stdin/stdout. The existing ACP e2e ([examples/acp-agent/tests/acp.e2e.ts](../../../../examples/acp-agent/tests/acp.e2e.ts)) is the closest end-to-end check, but it is key-gated and asserts on a handful of *structured fields* (`stopReason`, a `tool_call` title), not the byte-for-byte stream of `session/update` frames. That leaves the "green units, broken product" gap: every unit test can pass while the actual editor-facing protocol output regresses — the same class of failure that shipped the inject bug ([docs/postmortem/0001](../../../postmortem/0001-acp-default-export-drops-inject.md)), where 178 hand-mounted tests stayed green while a real Zed session crashed instantly.

The blocker for a full-transcript test is the model: the agent's output is driven by a non-deterministic LLM, and a key-gated test that hits the real API on every run is neither deterministic nor CI-runnable. We want the fidelity of a real run with the determinism of a fixture.

This RFC records the decision to add a third test tier — **snapshot tests** — and the design choices that make it deterministic, keyless-in-CI, and cheap to maintain.

## Decision

A snapshot test boots the **real** `examples/acp-agent` subprocess, drives it over real ACP stdio with a deterministic input script, and diffs its (normalized) output against committed golden files. The model is made deterministic by **recording a real run's session log once** against the real API and **replaying it** on every subsequent run. The committed fixture IS the persisted session JSONL — the same append-only log the harness writes for any session.

### The fixture is the persisted session JSONL

The per-scenario fixture is `<scenario>/session.jsonl`: the exact log produced by running the scenario once against the real API (the snapshot harness harvests the file the JSONL persistence backend writes). This log already contains everything needed to reproduce the run deterministically: its `assistant/chunk` events carry every parsed `StreamChunk` (the LLM's behavior), and its `tool/call`/`tool/result`/`turn/*`/`assistant/message` events carry the harness's behavior (token usage rides on `assistant/message.usage`). One artifact captures both, and it is the format the codebase already treats as the authoritative replay record ([packages/core/session/src/types.ts](../../../../packages/core/session/src/types.ts): "raw chunks are the replay record").

An earlier draft used a hand-authored `llm.json` of model chunks; reusing the real session log instead means the fixture is a genuine product of the system (not a hand-built mock), and it doubles as a behavioral golden (see below). A byte-level HTTP-record library (Polly/nock/MSW) was rejected: adapter-specific, awkward with streaming SSE, and lower-level than the thing under test.

### Replay derives the model script from the log

The replay seam is the provider-agnostic `llm/stream` waterfall ([packages/llm/llm/src/index.ts](../../../../packages/llm/llm/src/index.ts)) — a single listener intercepts every model call regardless of adapter (deepseek, pi-ai), because the loop routes all model calls through `ctx.llm.stream()`. The `llm-replay` plugin short-circuits that waterfall (never calls `next()`) and serves back streams reconstructed from the log: `deriveReplayScript(events)` groups `assistant/chunk` events by `(turn, step)` in log order, yielding one model stream per group. This grouping is exact because the agent loop makes **exactly one `ctx.llm.stream()` call per step** and tags every chunk with the current `(turn, step)` ([packages/core/agent-loop/src/loop.ts](../../../../packages/core/agent-loop/src/loop.ts)): `step` increments once per loop iteration, so `(turn, step)` is unique per model call. A `finish {kind:'error'}` chunk is part of its group and replays naturally — no special-casing.

### The in-memory replay entry honors the full LLM contract

`deriveReplayScript` produces a list of `ReplayEntry`, the in-memory unit the replay listener serves positionally:

```
{ kind: 'chunks', chunks: StreamChunk[] }
| { kind: 'throw', chunks: StreamChunk[], message: string, code: string, status?: number }
| { kind: 'hang' }
```

`chunks` is what the log derives. The other two cover the LLM contract's failure branches the log **cannot** reconstruct from `assistant/chunk` alone: a *pure throw before any chunk* (e.g. an HTTP 401 — the log holds only a `turn/end {error}`, no chunks) and a *cancel/hang* (a timing behavior, not chunk content). A scenario needing those supplies an optional `<scenario>/replay.override.json` (a `ReplayEntry[]`) that **replaces** the derived script. The `throw` entry carries any prefix chunks so a mid-stream failure replays its partial output before throwing — the "honor cross-seam contracts on BOTH sides" defensive pattern. Synthesizing throw/cancel from the log's `turn/end {kind:error|aborted}` was rejected: it would couple `llm-replay` to loop-internal turn-closing semantics and the `turn/end` reason is lossy (it can't distinguish a thrown 401 from a finish-error). An explicit sidecar is the cleaner seam.

### Positional replay, one in-flight stream

Replay is positional: the Nth `stream()` call serves the Nth `ReplayEntry`. This is deterministic **only when at most one model stream is in flight at a time**. The first cut runs one ACP session per scenario, which guarantees that. Multi-session concurrency (the bridge multiplexes N sessions, which can prompt concurrently) would let scheduling decide which model call consumes which entry — so concurrent-session snapshots are out of scope until entries are keyed by request rather than position. A scenario whose control flow changes the number/order of model calls must be re-recorded; the cursor **fails loud on overrun** rather than silently reusing or skipping an entry. A missing `session.jsonl` in replay fails loud too ("record first") — never a silent skip.

### Recording harvests the log; keyless replay needs a providerless config

Recording runs the scenario with the real `llm-deepseek` adapter and the JSONL persistence backend, then copies the produced `.jsonl` into the scenario dir. Per-event appends are durable, but the harness shuts the subprocess down gracefully (close stdin → `await ctx.dispose()`) before harvesting so the final events are flushed. `llm-replay` itself does no recording — it is replay-only.

`examples/base.yml` always loads `@deepseek-ai/dsh-llm-deepseek`, whose `apply` throws when no API key is present ([packages/llm/llm-deepseek/src/index.ts](../../../../packages/llm/llm-deepseek/src/index.ts)). So replay cannot reuse the normal config — it uses a dedicated `examples/acp-agent/cordis.snapshot.yml` that installs `llm-replay` in place of the adapter. To avoid duplicating the rest of the tree, the providerless core is factored into `examples/base-core.yml` (shared by `base.yml = base-core + llm-deepseek` and the replay config = `base-core + llm-replay`), and the agent-loop/persistence/ACP-bridge tail into `examples/acp-agent/acp-tail.yml` (shared by `cordis.yml` and the replay config). Recording reuses the normal `cordis.yml` (real adapter) — its persistence root reads `$DSH_SNAPSHOT_SESSIONS_ROOT` when the harness sets it — so there is no separate record config. In replay mode `start.ts` skips `.env` loading so a stray key cannot trigger a live call.

### Two goldens: normalize, then snapshot

A snapshot run asserts **two** normalized goldens, because the harness's external surfaces are distinct:

1. The **stdout transcript** — the framed `session/update` JSON-RPC the editor sees. Catches regressions in the ACP bridge's event→update translation (`streamSessionEventUpdate`).
2. The **re-derived session JSONL** — the log the replay run itself persists, compared against the recorded fixture. Catches regressions in the loop, tool dispatch, and turn/step structure that never surface on stdout.

The two are genuinely additive: stdout is the bridge's *lossy projection* of the log (it drops `assistant/message.usage`, `step/*`, exact `seq`/`time`, and renders tool I/O differently), so a loop/tool/turn-structure regression can change the JSONL while leaving the stdout projection identical, and a bridge-translation regression can change stdout while the JSONL is untouched. Asserting the JSONL equality also echoes the proposed [universal replay fixture](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.md) idea.

Both surfaces contain non-deterministic values that a pure normalization function scrubs **before** the snapshot: `randomUUID()` session ids → `{{sessionId}}`, the temp `mkdtemp` cwd → `{{cwd}}` (it appears in terminal-card `_meta` and the log header), JSON-RPC ids → a stable sequence, and the log's per-event `time` (epoch ms) + header `createdAt` dropped or zeroed (the log's `seq` is left intact — it is deterministic by contract, `seq = log.length`). Real bash runs during replay, so the JSONL normalizer additionally stabilizes tool-output volatility (any embedded paths/pids/timestamps) — scenarios keep bash commands tightly constrained (`echo`, file writes; no `date`/`env`/background/large-output) so this surface is small. The goldens are themselves **JSONL** — one compact, normalized record per line, in the same shape as the surfaces they mirror (NDJSON on the wire, JSONL on disk: `stdout.golden.jsonl`, `session.golden.jsonl`), so they stay `grep`/`jq`-able and faithful to what the agent actually emits. A separate raw-purity assertion keeps the guarantee that every stdout line parses as JSON (no logger leak onto the protocol channel). Vitest's `toMatchFileSnapshot` provides the golden store and the `-u`/`--update` "accept the diff" workflow.

### Isolation: normalization now, sandbox later


Determinism of the tool environment comes from a per-test `mkdtemp` cwd, the executor's existing secret-scrubbing env (`/KEY|SECRET|TOKEN/i`), the fresh non-login `bash -c` per call, and the normalization pass — **not** from an OS sandbox. A real rootless sandbox (bwrap on Linux, sandbox-exec/Seatbelt on macOS) is the established cross-platform pattern (Claude Code, Codex), but it is per-OS, fragile on newer kernels (Ubuntu 24.04+ AppArmor blocks unprivileged user namespaces), and unnecessary for transcript determinism. It is reserved as a future tier via the documented `BashExecutor` capability seam ([a sandboxing executor replaces dsh-bash-local without touching a tool schema](../architecture/2026-06-13-capability-seams.md)) — a new `bash-*` package, not a change here. Scenarios keep bash commands tightly constrained (no `date`/`env`/background/large-output) so the temp-dir tier suffices.

### The replay plugin is its own package

The replay plugin lives in its own package, `@deepseek-ai/dsh-llm-replay` (`packages/support/llm-replay/`), and the snapshot config references it by package name. It is the keyless replacement for the real LLM adapter: it installs an `llm/stream` waterfall listener and short-circuits it, serving model streams reconstructed from a recorded session JSONL. Its sole consumer is the ACP snapshot harness here, but it is a package (not example-local glue like echo-agent's [mock-llm.ts](../../../../examples/echo-agent/src/mock-llm.ts)) so that its derive/parse/replay branches fall under the per-file 100% coverage gate on package `src` trees — logic under `examples/` is not measured by that gate, which would leave those branches unguarded.

### Two subcommands, replay in the default gate

`pnpm run test:snapshot` runs replay (keyless) and is composed into the default `pnpm run test` gate so every PR gets the regression check (the main `vitest.config.ts` include stays narrow; the gate is `test && test:snapshot`). `pnpm run test:snapshot:record` requires `DEEPSEEK_API_KEY` (loaded from repo `.env` first), hits the real API, harvests the produced `session.jsonl`, and `--update`s both goldens in one pass. Both forward a scenario filter. A missing fixture in replay **fails loud** with a "record first" message rather than self-skipping (the e2e self-skip rule is a CI-secret accommodation, not appropriate here — a committed-fixture test that silently vanishes is a coverage hole). A no-model scenario's `session.jsonl` simply has no `assistant/chunk` events (empty derived script); fail-loud still applies if a model call happens with no entry. An orphan-fixture guard test fails on a golden/fixture not referenced by any scenario (Vitest does not prune orphaned raw goldens).

## Consequences

A new test tier and its fixtures to maintain: each scenario is a directory of `input.json` (the client stdin script) + `session.jsonl` (the recorded log) + an optional `replay.override.json` + an optional `workspace/` seed dir + the two `*.golden.jsonl` files, committed and reviewed. A scenario that needs the agent to operate on existing files (read, edit, grep) ships a `<scenario>/workspace/` directory; the harness copies its contents into the temp cwd before the run, so the seeded files are present for both record and replay (the cwd is normalized in the goldens, so the seeded paths stay stable). Re-recording when the model's phrasing changes churns the goldens — visible in review, which is the point of committing them. Bought: deterministic, keyless, full-transcript regression coverage that boots the real Loader (so it still guards the export-shape bug class), exercises the real bash executor, and gives a one-command accept-the-diff loop. The tier is ACP-first but the harness (subprocess + tee + input-DSL + workspace seeding + normalization + JSONL-derived replay) is example-agnostic and extends to other examples.

This RFC relates to but does not supersede the [proposed determinism RFC](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.md): that proposal's "universal replay fixture" re-derives session *message history* after every test (an internal-consistency invariant), whereas snapshot tests pin the *external protocol output*. They are complementary — one guards the event-sourcing invariant, the other guards the editor-facing contract.
