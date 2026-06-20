# RFC: Drop the unconsumed `streamBlocks()` assembled-view surface on `dsh-llm`

Status: proposed

## Problem

`LlmService` ([packages/llm/src/index.ts](../../../packages/llm/src/index.ts)) exposes three call surfaces over a model:

- `stream()` — raw `StreamChunk`s, dispatched through the `llm/stream` waterfall.
- `streamBlocks()` — a "convenience view" that runs the chunks through a `BlockAssembler` and yields completed `ContentBlock`s in stream order ([index.ts:137-144](../../../packages/llm/src/index.ts)).
- `generate()` — one fully-assembled `GenerateResult`, dispatched through a second `llm/generate` waterfall ([index.ts:151-157](../../../packages/llm/src/index.ts)).

The only production consumer of the LLM service is the agent loop, and it uses `stream()` exclusively — feeding the raw chunks through its own `BlockAssembler` so it can log raw chunks for replay fidelity while assembling in parallel ([packages/agent-loop/src/loop.ts](../../../packages/agent-loop/src/loop.ts), the `ctx.llm.stream(req)` step). Grepping `streamBlocks` across `packages/*/src` and `examples/*/src` finds zero callers; the only references are the method itself, two doc comments, and two test files (`llm/tests/properties.spec.ts`, `agent-loop/tests/review-fixes.spec.ts`).

This is the [drop-mutable-session-summary](../implemented/2026-06-19-drop-mutable-session-summary.md) pattern: an entire assembled-view API with a property-tested contract, consumed by nothing but its own tests. It was built speculatively for "consumers that don't care about token-level deltas" that never materialized — the one real consumer cares about deltas precisely so it can log them.

`streamBlocks()` also drags a dedicated slice of `BlockAssembler` behind it: `flushReady()` and `flushRemaining()` ([packages/llm/src/assembler.ts:138-168](../../../packages/llm/src/assembler.ts)) plus the `flushed` cursor field exist only to support the incremental in-order yield. The loop's assembler usage is `push()` / `message()` / `usage` / `finish` — never the streaming flush. With `streamBlocks()` gone, `flushReady`/`flushRemaining`/`flushed` are dead too.

## Proposal

Delete `streamBlocks()` and the assembler's streaming-flush machinery it alone drives:

- Remove `LlmService.streamBlocks()` and its JSDoc.
- Remove `BlockAssembler.flushReady()`, `BlockAssembler.flushRemaining()`, and the `flushed` cursor field.
- Remove or rework the `flushReady`/`flushRemaining`-dependent tests: in `llm/tests/properties.spec.ts` the `flushReady() ++ flushRemaining() === blocks()` property, the strict-order property, and the "streaming and one-shot assembly agree on usage and finish" property (which pushes-then-flushes incrementally) all exercise the streaming-flush path; the `flushRemaining` cases in `llm/tests/assembler.spec.ts` and the three `streamBlocks` edge-case tests in `agent-loop/tests/review-fixes.spec.ts` likewise. Each is either deleted or, where it also asserts a non-flush invariant worth keeping (e.g. streaming vs one-shot agreeing on usage/finish), rewritten to use `push()` + `message()`/`result()` without the removed flush methods — the behavior pinned to the deleted methods goes, per AGENTS.md "tests document behavior, not golden truth".
- Update every doc/comment reference to `streamBlocks` — grep it across `docs/`, `packages/llm/README.md`, and source comments. `packages/llm/README.md` mentions it twice (the API-list row and the `BlockAssembler` "used by `streamBlocks()`/`generate()`" line); the `assembler.ts` module doc references it; and the retained `generate()` JSDoc currently reads "Same completion guarantees as `streamBlocks()`" — reword it to state the guarantee directly. The `ctx.llm` service-map row in [docs/architecture.md](../../../docs/architecture.md) (`stream()` / `streamBlocks()` / `generate()`) drops `streamBlocks()` too. The [property-based-testing RFC](../implemented/2026-06-11-property-based-testing.md) needs two edits: its motivating anecdote ("a `streamBlocks` ordering bug") is reworded to name the bug class (a block-assembly ordering bug) rather than a removed method, and its dsh-llm invariant list — which names `flushReady()+flushRemaining() ≡ blocks()` as a checked property — is updated to drop the removed-method invariant and keep only the ones the surviving assembler API (`push`/`blocks`/`message`/`result`) still supports.

## Scope: why `generate()` and `llm/generate` stay

`generate()` is not dead the same way: the twin-adapter e2e/unit suites (`llm-deepseek`, `llm-pi-ai`) use `ctx.llm.generate({...})` as a convenient one-shot driver to assert provider behavior, and `GenerateResult` / `assembler.result()` back it. Those adapter tests are the [twin-adapter design](../implemented/2026-06-13-twin-llm-adapters.md), explicitly out of scope for a simplification pass. Removing `generate()` would force adapter-test call sites to hand-drain `stream()`, which is churn in protected territory for a method that is at least a legitimate ergonomic driver. So this RFC deliberately stops at the surface that nothing — not even an out-of-scope test — consumes. If a later pass wants to also collapse `generate()`/`llm/generate`/`result()`, that is a separate decision with a real caller to migrate.

## Acceptance criteria

- `streamBlocks` and the assembler streaming-flush methods are gone; `pnpm run knip` reports no new dead exports.
- `pnpm run test:coverage` stays at 100% per-file (the deleted methods take their dedicated tests with them; no remaining line goes uncovered).
- `generate()`, `stream()`, `result()`, `blocks()`, `message()` are untouched and the loop behaves identically — verified by the unchanged ACP snapshot goldens.
- `packages/llm/README.md` and the module docs no longer mention `streamBlocks`.

## Risks

- **It removes a public method from a core vocabulary package.** A future plugin that wants "assembled blocks without the deltas" would have to re-add it (or call `generate()` and read `.message.content`). Given the pre-release "foundation over speculative future" stance ([AGENTS.md](../../../AGENTS.md)) and that the obvious assembled-view need is already served by `generate()`, this is the right time to cut — re-adding a thin assembler wrapper later is trivial if a real consumer appears.
- **Low blast radius.** The change is confined to `dsh-llm`; no other package imports `streamBlocks` or the flush methods, so there is no cross-package ripple.

The size is modest, but it is a clean, zero-production-impact removal of a speculative surface — the cheapest kind of correctness.
