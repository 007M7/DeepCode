# RFC: Core-data-structures catalog and the `ts type-equiv` drift gate

Status: implemented (accepted 2026-06-20)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

A reader trying to understand the harness could find its *behavior* in [architecture.md](../../../architecture.md) (the service map, the session/turn/step lifecycle, the event taxonomy) but had no single place describing its *vocabulary* — the data structures that behavior moves around. The type shapes lived only in source, scattered across `packages/*/src/types.ts`, so understanding "what is a `Message`, a `SessionEvent`, a `StreamChunk`" meant reading the declarations directly. A prose catalog would help, but a catalog that paraphrases or paste-copies type definitions rots the instant a field changes — and an out-of-sync type doc is worse than none, because a reader trusts it.

So the work had two intertwined questions: **what belongs in such a catalog** (the scoping problem — a harness has dozens of cross-package types and dumping all of them helps no one), and **how to keep pasted type definitions from drifting** (the durability problem). This RFC records both decisions. Its sibling, [the generated cordis events + services catalog](2026-06-20-generated-cordis-catalog.md), is the *wiring*-axis complement: this one catalogs the data structures, that one the events and services that move them.

## Decision

A new `docs/core-data-structures/` folder catalogs the vocabulary, with a new `verify-type-equiv` doc-sync gate that keeps every pasted type definition byte-identical to its source.

### What counts as "core" — the spine-vs-seam line

The scoping line was not picked top-down; it was discovered by testing candidate definitions against concrete borderline types until one rule survived every case. The decisive test was `BashExecRequest`/`BashExecSpec`/`BashRunResult`: bash is a capability *seam*, not part of the agent-loop spine, so if those are "core" then "core" means *all cross-package vocabulary* and the catalog is a flat dump; if they are not, "core" means *the central spine* and bash vocabulary belongs on a sub-page. The latter won, which set the whole structure: a **tiered folder**, not a flat document.

The rule that settled the remaining cases: ***the type you write, hold, or receive is core; the machinery that types it, renders it, or persists it is a sub-page detail.*** Worked through:

- A data structure is **core** if it flows through the agent-loop spine — the loop holds, derives, streams, or logs it on every turn regardless of which plugins load (`Message`, `StreamChunk`, `SessionEvent`, the `Agent` handle) — **or** it is the single headline type a plugin author writes against a pipeline (`ToolDefinition`).
- `ToolDefinition` is core (it is what every tool author writes) **even though the loop never holds one** — authoring-importance overrides the strict flows-through-spine rule for this one headline type. But its typing machinery — the `SchemaSpec`/`InferArgs` DSL — is a sub-page detail (you write a `ToolDefinition`; the type-level machinery that types it you do not). That is the spine-vs-seam line made sharp.
- `ToolSchema` is core (it is a field of `GenerateOptions`, the model request that flows through every step) even though it is conceptually part of the tool pipeline — *flows through the spine* wins over *conceptual home* when they conflict.
- The tool-presentation vocabulary (`ToolCallView`/`ToolResultView`, …), the `SessionPersistence` durability seam, and bash vocabulary are sub-pages.

`core.md` is a **self-contained spine doc**: it states the exact type definition of each spine structure with minimal prose and links to sub-pages for the per-seam detail. The sub-pages are `llm-streaming.md`, `session.md`, `persistence.md` (split from session along the in-memory-model vs. durability-seam line), `tools.md`, and `bash.md`.

### The `ts type-equiv` mechanism — literal AND drift-proof

The durability requirement was specific: the doc should show the **literal** current type definition (so a reader sees the real shape, not a paraphrase) **and** be mechanically guaranteed to match source. The repo already compiles fenced ` ```ts ` blocks (`doc-typecheck`), but a real typechecked block needs import noise and proves only *assignability*, not *byte-equality* — a renamed field with the same type would pass. So:

- Type definitions are pasted verbatim into a dedicated ` ```ts type-equiv ` fence. `doc-typecheck` recognizes the fence and skips it (a bare definition is not standalone-compilable), and **excludes it from the opt-out ratio** — it is a separately-checked category, not an unchecked sketch.
- A new `scripts/verify-type-equiv.ts` extracts each block via the TypeScript parser and asserts a **verbatim source match** against the declared symbol — chosen over a compiled `_Check` assertion precisely because byte-equality, not assignability, is the property we want.
- Provenance lives in a central `scripts/type-equiv.manifest.json` (`{ doc, symbol, source }` entries), **not** in directive comments in the prose. The script enforces a **1:1 correspondence**: every type-equiv block has exactly one manifest entry and vice versa, so a block can never be silently unchecked and an entry can never rot.
- Wired into `doc-sync`, so it runs in the same lefthook pre-push and CI paths as the other doc gates.

### Maintenance is the author's job, with a gate backstop

`verify-type-equiv` catches a *drifted paste* of an already-documented type, but it cannot tell you a brand-new core type went undocumented. So AGENTS.md and the `dsh-code-review` skill were updated to require keeping the catalog in sync when a change adds or reshapes a documented type — the gate handles drift, the human handles new surface.

## Process

The design was driven entirely by a one-question-at-a-time grilling that walked the scoping decision tree through concrete examples (`BashExecRequest`, `ToolSchema`, `ToolDefinition`, the schema DSL, the presentation types, the session/persistence split) before committing to the spine-vs-seam rule — the rule was the *output* of the examples, not an a-priori axiom. The implementation landed as four commits mirroring the structure of the work: the gate (`e97f94b`), the catalog (`7e33c7b`), the maintenance-guard updates (`53e01a0`), and a review-fix commit (`6da7a0f`).

That last commit is why the process is worth recording: an independent Codex review (gpt-5.5:xhigh) found a real **scan-gap bug** — `verify-type-equiv` only scanned the docs the manifest named, so a type-equiv block added to an *unmanifested* doc was silently skipped, defeating the 1:1 guarantee in one direction. The fix scans every doc in the markdown scope and reports an unmanifested block as an orphan. The same review corrected a `SessionPersistence` surface-listing prose error (`has`/`delete`) and the `doc-sync` command summary. The bug is the point: a drift gate that silently skips part of its input is worse than no gate, and only an adversarial reader caught it.

This decision shipped in #71 **without** an RFC at the time — the judgment was that the `ts type-equiv` convention was small enough to document in `development.md`. This RFC is the retroactive record: the spine-vs-seam scoping rule and the verbatim-match-over-assignability choice are exactly the kind of "why was it done this way?" decisions a future maintainer would otherwise re-litigate, and its sibling catalog ([generated cordis events + services](2026-06-20-generated-cordis-catalog.md)) does carry an RFC, so the pair should be documented symmetrically.

## Consequences

- The vocabulary now has a single home that **cannot silently drift**: a field rename in source fails `verify-type-equiv` in the pre-push hook and CI until the paste is refreshed.
- The spine-vs-seam line is a reusable scoping tool, not a one-off: the same "the thing you write/hold/receive is core; the machinery that types/renders/persists it is a detail" rule is what later scoped the events/services catalog's harness-vs-inherited tiering.
- The `ts type-equiv` fence is a third doc-block category alongside ` ```ts ` (compiled) and ` ```ts ignore-check ` (sketch). A later sibling added a fourth, ` ```ts cordis-catalog ` (generated signature), reusing the same skip-and-exclude treatment.
- Adding or reshaping a core type now carries a documentation obligation the author must honor (the gate cannot detect a missing *new* type), backstopped by the `dsh-code-review` checklist.
