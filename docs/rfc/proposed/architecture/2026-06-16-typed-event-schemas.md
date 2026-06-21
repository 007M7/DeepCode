# RFC: Runtime schemas for the event vocabulary (Zod vs the merge-extensible-map pattern)

Status: proposed

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Problem

The harness models its core vocabulary — content blocks, message sources, finish reasons, turn triggers, turn-end reasons, and session events — as **merge-extensible maps**: a TypeScript `interface` (e.g. `SessionEventMap`, `ContentBlockMap`) that plugins augment via declaration merging, with the public union derived as `Map[keyof Map]`. This is the repo's universal extension pattern, documented in [docs/architecture.md](../../../architecture.md) ("The same merge-extensible-map pattern is used for `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`") and relied on by the `defineTool` `InferArgs` DSL and the `assertNever` exhaustiveness convention.

The pattern is **compile-time only**. The types vanish at runtime: there is no schema object to validate an incoming value against, parse untrusted input with, or enumerate at runtime. Two concrete consequences surfaced in review of [the session-persistence work](../../implemented/architecture/2026-06-14-session-persistence.md) (#33):

1. **Persistence treats `event.data` as opaque JSON.** The JSONL/SQLite backends `JSON.stringify`/`JSON.parse` each event verbatim; the only runtime guard is `isJsonValue` (round-trip serializability — rejects BigInt, functions, cycles, non-finite numbers, …), NOT structural validation. A corrupted-but-still-JSON event datum (wrong field types, missing fields) round-trips silently and is only caught later, if at all, by a consumer's `switch`.
2. **No runtime contract for plugin-added variants.** A plugin that declaration-merges a new `SessionEventMap` key gets compile-time typing for its own code, but nothing validates that the values it produces match the shape it declared — at the producer, at the persistence boundary, or on reload.

A reviewer asked whether the project should move "all the JSON serialization/deserialization" — and ultimately the event vocabulary itself — to **Zod** (or a similar runtime-schema library), so the durable boundary and the plugin extension points are backed by runtime schemas rather than erased types.

This RFC scopes that question. It does **not** propose an implementation; it records the tradeoff so the decision is made deliberately rather than incrementally inside a persistence PR.

## Why this is not a persistence change

It is tempting to read "use Zod for serialization" as a local change to `dsh-session-persistence-jsonl/src/format.ts`. It is not, for one structural reason: **a plugin cannot declaration-merge a Zod schema.** Declaration merging is a TypeScript compile-time mechanism; a Zod schema is a runtime value. To validate events with Zod you need a **runtime registry** that every event-producing package contributes its schema to (e.g. `ctx.sessionEvents.register('compaction/marker', z.object({…}))`), and every consumer reads from. That registry — not the persistence backend — becomes the source of truth for the vocabulary, replacing the merge-extensible interface.

So the real proposal is: **replace the compile-time merge-extensible-map pattern with a runtime schema registry, repo-wide.** That is a core-vocabulary redesign.

## Blast radius (measured)

A migration of the event/vocabulary surface to runtime schemas touches, at minimum:

- **Six merge-extensible maps** (~370 LOC of core types): `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap` (in `dsh-llm`); `TurnTriggerMap`, `TurnEndReasonMap`, `SessionEventMap` (in `dsh-session`).
- **~10 `declare module` augmentation sites** across `dsh-agent`, `dsh-agent-loop`, `dsh-bash`, `dsh-llm`, `dsh-session`, `dsh-session-persistence`, `dsh-system-prompt`, `dsh-tools` — each would move from declaration merging to a runtime `register()` call.
- **The event producers** — 16 `session.append(...)` call sites in the loop — unchanged in shape but now validated at the boundary.
- **~7 switch-consumers** that branch on these unions: `deriveMessages` (`dsh-session`), `BlockAssembler` (`dsh-llm`), the `dsh-invariants` plugin, both LLM adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`), and the tool schema layer (`dsh-tools`). The `assertNever`-on-closed-unions vs fall-through-on-extensible-unions convention (a documented lint rule) would need rethinking — runtime variants are not statically exhaustive.
- **The `defineTool` `InferArgs` DSL** (`dsh-tools`), which derives zero-cast `execute` arg types from a compile-time schema spec — the showcase of the current approach.
- **Docs**: architecture.md (the pattern is described as foundational), [dev-mode invariants](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md), and any RFC that references the pattern.

This is a HUGE change. It is not in scope for the RFC-009 session-persistence work and must not be smuggled in through it.

## Options

### A. Status quo — merge-extensible types + `isJsonValue` at the durable boundary
Keep the compile-time pattern. Persistence stays opaque-JSON + serializability guard. Plugins extend via declaration merging; correctness of event *shape* is the producer's responsibility, enforced by TypeScript at compile time and by the `dsh-invariants` plugin's structural checks in dev.

- **Pros**: zero churn; plugin extension is a one-line `interface` augmentation with full type inference and no runtime registration ceremony; no new runtime dependency; the `defineTool` DSL and `assertNever` exhaustiveness keep working.
- **Cons**: no runtime structural validation at the persistence boundary or at plugin seams; a malformed-but-JSON datum is caught late.

### B. Header/closed-shape validation only (schemastery), events stay opaque
Tighten only the genuinely-closed shapes that already have hand-rolled type guards — e.g. the JSONL `HeaderLine` guard (`isHeaderLine`) — using **schemastery** (the repo's existing schema library, already used for every plugin `static Config`). Leave the merge-extensible event union as-is.

- **Pros**: small, fits the existing convention (schemastery, not a new lib); replaces hand-rolled guards on closed shapes with declarative schemas; no core redesign.
- **Cons**: does not address event-data validation (the thing the reviewer actually asked about); only helps the fixed metadata records.

### C. Runtime schema registry for the whole vocabulary (Zod or schemastery)
Replace the merge-extensible maps with a runtime registry the producers contribute to and the persistence/consumer paths validate against.

- **Pros**: real runtime validation at the durable boundary and at plugin seams; one source of truth; enables generic tooling (auto-generated docs, fuzzing, wire-format checks).
- **Cons**: the full blast radius above; **Zod is not currently a direct dependency** (only a transitive dep of `@earendil-works/pi-ai`) and the repo's chosen schema lib is **schemastery** — adopting Zod broadly is itself a dependency decision; declaration-merge ergonomics (one-line plugin extension, full inference) are replaced by runtime registration + manual type wiring; the `assertNever` exhaustiveness guarantee weakens (runtime variants aren't statically exhaustive).

## Recommendation

Defer. Do **not** change #33. If runtime validation is wanted at the durable boundary in the near term, **Option B** (schemastery on the closed header/metadata shapes) is the proportionate step and stays within the existing convention. **Option C** is a genuine architecture decision that should be evaluated on its own merits — including whether the chosen library is Zod or schemastery — and, if accepted, land as its own change with its own RFC, not as a side effect of persistence serialization.

## Open questions

- If a registry is adopted, is the library **schemastery** (already in the tree, already the config schema lib) or **Zod** (richer ecosystem, currently only transitive)? Adopting two schema libraries is a cost in itself.
- Can a hybrid keep compile-time inference (so `defineTool` and plugin DX survive) while adding an *optional* runtime schema per variant, validated only at the persistence/wire boundary rather than on every in-process append?
- Does the `dsh-invariants` plugin already cover enough of the runtime-shape gap in dev that boundary validation is only needed for genuinely untrusted input (reload of an externally-modified log)?
