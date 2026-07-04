# RFC: Drop unconsumed assembled LLM convenience surfaces

Status: implemented (proposed and accepted 2026-06-20)

## Problem

`LlmService` ([packages/llm/llm/src/index.ts](../../../../packages/llm/llm/src/index.ts)) exposes three call surfaces over a model:

- `stream()` — raw `StreamChunk`s, dispatched through the `llm/stream` waterfall.
- `streamBlocks()` — a "convenience view" that runs the chunks through a `BlockAssembler` and yields completed `ContentBlock`s in stream order ([index.ts:137-144](../../../../packages/llm/llm/src/index.ts)).
- `generate()` — one fully-assembled `GenerateResult`, dispatched through a second `llm/generate` waterfall ([index.ts:151-157](../../../../packages/llm/llm/src/index.ts)).

The only production consumer of the LLM service is the agent loop, and it uses `stream()` exclusively — feeding raw chunks through its own `BlockAssembler` so it can log chunks for replay fidelity while assembling in parallel ([packages/core/agent-loop/src/loop.ts](../../../../packages/core/agent-loop/src/loop.ts), the `ctx.llm.stream(req)` step). Grepping `streamBlocks` and `ctx.llm.generate` across `packages/*/src` and `examples/*/src` finds no production callers. The references are the service methods, docs, and tests; adapter tests use `generate()` as a convenient driver, but they can hand-drain `stream()` through the same assembler helper without preserving a public production API.

This is the [drop-mutable-session-summary](../../implemented/simplification/2026-06-19-drop-mutable-session-summary.md) pattern: assembled-view APIs with tested contracts, consumed by tests rather than production. They were built speculatively for consumers that do not care about token-level deltas, but the one real consumer cares about deltas precisely so it can persist high-fidelity replay data.

`streamBlocks()` drags a dedicated slice of `BlockAssembler` behind it: `flushReady()` and `flushRemaining()` ([packages/llm/llm/src/assembler.ts:138-168](../../../../packages/llm/llm/src/assembler.ts)) plus the `flushed` cursor field exist only to support incremental in-order yield. `generate()` drags `GenerateResult`, `BlockAssembler.result()`, and the `llm/generate` waterfall as a second interception surface over the same underlying stream. The loop's assembler usage is `push()` / `message()` / `usage` / `finish` — not streaming flush or one-shot service assembly.

## Proposal

Make `stream()` the only public LLM call surface:

- Remove `LlmService.streamBlocks()` and its JSDoc.
- Remove `LlmService.generate()`, the `llm/generate` waterfall event, and `GenerateResult` if no surviving API needs that named result shape.
- Remove `BlockAssembler.flushReady()`, `BlockAssembler.flushRemaining()`, and the `flushed` cursor field.
- Remove `BlockAssembler.result()` if it is only a helper for the deleted `generate()` service path and tests.
- Replace adapter-test use of `ctx.llm.generate()` with a small test helper that calls `ctx.llm.stream()`, pushes chunks into `BlockAssembler`, and returns the assembled message, usage, and finish reason needed by that test. That keeps the [twin-adapter design](../../implemented/architecture/2026-06-13-twin-llm-adapters.md) intact while avoiding a public method whose only callers are tests.
- Remove or rework the `flushReady`/`flushRemaining`-dependent tests. Keep assembler invariants that still apply to `push()` / `blocks()` / `message()`; delete behavior that only pins the removed flush API.
- Update every doc/comment reference to `streamBlocks`, `generate`, `GenerateResult`, and `llm/generate` across `docs/`, package READMEs, and source comments. The `ctx.llm` service-map row in [docs/architecture.md](../../../architecture.md) becomes `stream()` only, the event taxonomy drops `llm/generate`, and the [property-based-testing RFC](../../implemented/testing/2026-06-11-property-based-testing.md) names block-assembly invariants without referring to removed convenience methods.

## Acceptance criteria

- `streamBlocks`, `generate`, `llm/generate`, and the assembler helpers they alone require are gone; `pnpm run knip` reports no new dead exports.
- `pnpm run test:coverage` stays at 100% per-file (the deleted methods take their dedicated tests with them; no remaining line goes uncovered).
- Adapter tests still exercise both real adapters through `stream()` and the shared assembler, not through a test-only public shortcut.
- The loop behaves identically — verified by unchanged ACP snapshot goldens.
- `packages/llm/llm/README.md`, [docs/architecture.md](../../../architecture.md), and module docs no longer mention the removed convenience surfaces.

## Risks

- **It removes public methods from a core vocabulary package.** A future plugin that wants assembled blocks without deltas would need to call `stream()` and use `BlockAssembler` directly or reintroduce a focused helper with a real consumer. Given the pre-release "foundation over speculative future" stance ([AGENTS.md](../../../../AGENTS.md)), this is the right time to cut test-only public shape.
- **Adapter tests get a little more explicit.** They lose the ergonomic `generate()` wrapper, but that is useful pressure: tests exercise the same streaming path production uses.
- **Waterfall users lose `llm/generate`.** No production listener exists. Any future caching/retry/logging plugin should wrap `llm/stream`, which remains the single provider call path.

The size is modest, but it is a clean removal of speculative surface area from the LLM package, leaving one model-call contract for both production and tests.
