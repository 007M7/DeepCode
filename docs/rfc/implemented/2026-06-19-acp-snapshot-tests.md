# RFC: ACP snapshot tests — record-once / replay-deterministic

Status: implemented (accepted 2026-06-19)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The harness has two test tiers: keyless unit `.spec.ts` (the 100%-per-file coverage gate) and real-API `.e2e.ts` (key-gated, self-skipping in CI). Neither continuously verifies the **complete output transcript** an ACP editor (Zed) sees on its stdin/stdout. The existing ACP e2e ([examples/acp-agent/tests/acp.e2e.ts](../../../examples/acp-agent/tests/acp.e2e.ts)) is the closest end-to-end check, but it is key-gated and asserts on a handful of *structured fields* (`stopReason`, a `tool_call` title), not the byte-for-byte stream of `session/update` frames. That leaves the "green units, broken product" gap: every unit test can pass while the actual editor-facing protocol output regresses — the same class of failure that shipped the inject bug ([docs/postmortem/0001](../../postmortem/0001-acp-default-export-drops-inject.md)), where 178 hand-mounted tests stayed green while a real Zed session crashed instantly.

The blocker for a full-transcript test is the model: the agent's output is driven by a non-deterministic LLM, and a key-gated test that hits the real API on every run is neither deterministic nor CI-runnable. We want the fidelity of a real run with the determinism of a fixture.

This RFC records the decision to add a third test tier — **snapshot tests** — and the design choices that make it deterministic, keyless-in-CI, and cheap to maintain.

## Decision

A snapshot test boots the **real** `examples/acp-agent` subprocess, drives it over real ACP stdio with a deterministic input script, and diffs its (normalized) stdout transcript against a committed golden file. The model is made deterministic by **recording its streamed responses once** against the real API and **replaying them** on every subsequent run.

### Record/replay at the `llm/stream` waterfall

The record/replay seam is the provider-agnostic `llm/stream` waterfall ([packages/llm/src/index.ts](../../../packages/llm/src/index.ts)), not an HTTP-record library and not an adapter swap. The agent loop calls `ctx.llm.stream()` for every model call (and `generate()` also drains `stream()` internally), so a single waterfall listener intercepts every model interaction regardless of which adapter (deepseek, pi-ai) is installed. The recorded unit is the parsed `StreamChunk` — provider-neutral, JSON-serializable, and already the unit the loop treats as "the replay record" ([packages/agent-loop/src/loop.ts](../../../packages/agent-loop/src/loop.ts)).

A byte-level HTTP-record library (Polly/nock/MSW) was rejected: it would be adapter-specific (the two adapters share only the `StreamChunk` contract, not transport internals), it handles streaming SSE awkwardly, and it records at a lower level than the thing under test. Recording parsed chunks is simpler, robust, and human-reviewable.

### Fixture entry schema honors the full LLM contract

The LLM contract ([packages/llm/src/types.ts](../../../packages/llm/src/types.ts)) allows an adapter to report failure two ways: *throw from `stream()`*, or *end the stream with a `finish {kind:'error'|'aborted'}` chunk*. A fixture of bare `StreamChunk[]` could only replay the second. So each `llm.json` entry is a discriminated record:

```
{ kind: 'chunks', chunks: StreamChunk[] }
| { kind: 'throw', message: string, code: string, status?: number }
| { kind: 'hang' }
```

`throw` replays the thrown-error branch (e.g. a provider 401), and `hang` (one chunk, then wait for abort) replays cancellation — mirroring the `hang` marker in the existing [MockAdapter](../../../packages/agent-loop/tests/mock-adapter.ts). This keeps both contract branches exercised through the real consumer, per the "honor cross-seam contracts on BOTH sides" defensive pattern.

### Positional replay, one in-flight stream

Replay is positional: the Nth `stream()` call in a scenario returns the Nth recorded entry (a cursor with `shift()` semantics, like MockAdapter). This is deterministic **only when at most one model stream is in flight at a time**. The first cut runs one ACP session per scenario, which guarantees that. Multi-session concurrency (the bridge multiplexes N sessions, which can prompt concurrently) would let scheduling decide which model call consumes which entry — so concurrent-session snapshots are explicitly out of scope until fixture entries are keyed by request rather than position. A scenario whose control flow changes the number/order of model calls must be re-recorded; the cursor **fails loud on overrun** rather than silently reusing or skipping an entry.

### Record flushes per-stream, not on dispose

The example subprocess is terminated with `SIGKILL` by the test teardown, and `start.ts` has no disposal path, so a `ctx.effect` disposer that flushed `llm.json` at teardown would never run. Record mode therefore flushes the fixture **atomically after each completed stream** (write-temp-then-rename). A minimal graceful-shutdown path (SIGTERM / stdin-end → `await ctx.dispose()`) is added for cleanliness, but fixture durability does not depend on it.

### Keyless replay needs a providerless config

`examples/base.yml` always loads `@deepseek-ai/dsh-llm-deepseek`, whose `apply` throws when no API key is present ([packages/llm-deepseek/src/index.ts](../../../packages/llm-deepseek/src/index.ts)). So replay cannot reuse the normal config — it uses a dedicated `examples/acp-agent/cordis.snapshot.yml` that omits `llm-deepseek` and installs the replay plugin in its place. Record mode loads the real adapter *and* the replay plugin (which tees it). In replay mode `start.ts` also skips `.env` loading so a stray key cannot trigger a live call.

### Normalize, then snapshot parsed frames

The transcript contains non-deterministic values: `randomUUID()` session ids, the temp `mkdtemp` cwd (which appears in terminal-card `_meta`), JSON-RPC ids, and timing. A pure normalization function replaces these with stable tokens (`{{sessionId}}`, `{{cwd}}`, sequenced ids; volatile numerics dropped/rounded) **before** the snapshot. The golden holds normalized, stable-stringified frames (not opaque bytes) for clean, line-diffable PRs; a separate raw-purity assertion keeps the existing guarantee that every stdout line parses as JSON (no logger leak onto the protocol channel). Vitest's `toMatchFileSnapshot` provides the golden store and the `-u`/`--update` "accept the diff" workflow.

### Isolation: normalization now, sandbox later

Determinism of the tool environment comes from a per-test `mkdtemp` cwd, the executor's existing secret-scrubbing env (`/KEY|SECRET|TOKEN/i`), the fresh non-login `bash -c` per call, and the normalization pass — **not** from an OS sandbox. A real rootless sandbox (bwrap on Linux, sandbox-exec/Seatbelt on macOS) is the established cross-platform pattern (Claude Code, Codex), but it is per-OS, fragile on newer kernels (Ubuntu 24.04+ AppArmor blocks unprivileged user namespaces), and unnecessary for transcript determinism. It is reserved as a future tier via the documented `BashExecutor` capability seam ([a sandboxing executor replaces dsh-bash-local without touching a tool schema](2026-06-13-capability-seams.md)) — a new `bash-*` package, not a change here. Scenarios keep bash commands tightly constrained (no `date`/`env`/background/large-output) so the temp-dir tier suffices.

### Example-local plugin, not a new package

The replay plugin lives at `examples/acp-agent/src/llm-replay.ts`, referenced from the snapshot config by relative path — exactly how echo-agent wires its [mock-llm.ts](../../../examples/echo-agent/src/mock-llm.ts). It is test/example infrastructure with one consumer; the capability-seams rule says not to split into a published `packages/` trio preemptively. It is promoted to a package only when a second example needs it.

### Two subcommands, replay in the default gate

`pnpm run test:snapshot` runs replay (keyless) and is composed into the default `pnpm run test` gate so every PR gets the regression check (the main `vitest.config.ts` include stays narrow; the gate is `test && test:snapshot`). `pnpm run test:snapshot:record` requires `DEEPSEEK_API_KEY` (loaded from repo `.env` first), hits the real API, and `--update`s both `llm.json` and the golden in one pass. Both forward a scenario filter. A missing fixture in replay **fails loud** with a "record first" message rather than self-skipping (the e2e self-skip rule is a CI-secret accommodation, not appropriate here — a committed-fixture test that silently vanishes is a coverage hole). No-model scenarios commit `llm.json` as `[]` so fail-loud and the no-model case don't conflict. An orphan-fixture guard test fails on a golden/fixture not referenced by any scenario (Vitest does not prune orphaned raw goldens).

## Consequences

A new test tier and its fixtures to maintain: each scenario is a directory of `input.json` + `llm.json` + `stdout.golden.txt`, committed and reviewed. Re-recording when the model's phrasing changes churns the goldens — visible in review, which is the point of committing them. Bought: deterministic, keyless, full-transcript regression coverage that boots the real Loader (so it still guards the export-shape bug class), exercises the real bash executor, and gives a one-command accept-the-diff loop. The tier is ACP-first but the harness (subprocess + tee + input-DSL + normalization + record/replay waterfall) is example-agnostic and extends to other examples.

This RFC relates to but does not supersede the [proposed determinism RFC](../proposed/2026-06-11-deterministic-and-stress-testing.md): that proposal's "universal replay fixture" re-derives session *message history* after every test (an internal-consistency invariant), whereas snapshot tests pin the *external protocol output*. They are complementary — one guards the event-sourcing invariant, the other guards the editor-facing contract.
