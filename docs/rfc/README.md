# RFCs

One kind of design doc lives here. An **RFC** records a decision or proposal that shapes this codebase — the *why* and *what we gave up*, the parts code and docs can't carry. (Earlier this split into separate "ADR" and "RFC" trees; they were unified, since most ADRs were simply implemented RFCs.)

## Layout and naming

Files are grouped by lifecycle into three folders, and an RFC moves between them as its status changes:

- **`proposed/`** — proposals reviewed before implementation; not yet built (or only partly).
- **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is **kept current with what actually shipped**: when the code later moves a file, renames a package, or changes a key/default, the RFC is updated in the same change to match (facts only — paths, names, structure — not the decision itself). See [implemented/AGENTS.md](implemented/AGENTS.md).
- **`rejected/`** — the proposal was considered and declined. Kept for the record so the rejection isn't re-litigated.

Each file is named `yyyy-mm-dd-topic-title.md`, where the date is when the topic was **first proposed** (per git history). Cross-references between RFCs use relative markdown links (`[topic](../implemented/2026-…-….md)`) — never bare prose or numbers — so they are mechanically checkable and survive moves between folders.

## When to write one

Write an RFC when a decision is **durable** (it shapes the codebase beyond a single function or package), **contested** (there was a real alternative a reasonable engineer might have chosen), and **surprising** (a future reader would otherwise ask "why on earth is it done this way?"). A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`.

Do NOT write one for a mechanical or local choice (a variable name, a one-file refactor), for anything already enforced and explained by a gate or a convention in AGENTS.md, or for a still-provisional decision tagged `TODO(...)` in the code — record those as TODOs and promote to an RFC only once they settle. An RFC is never edited into a *different decision*: supersede it with a new one and cross-link. (Editing an `implemented/` RFC to track where its already-made decision now *lives* — a moved file, a renamed package — is not a different decision and is required, not forbidden; see [implemented/AGENTS.md](implemented/AGENTS.md).)

## Proposed

| Title | First proposed |
|---|---|
| [Mutation testing as the coverage counterweight](proposed/2026-06-11-mutation-testing.md) | 2026-06-11 |
| [Deterministic tests, the replay invariant fixture, and race stress](proposed/2026-06-11-deterministic-and-stress-testing.md) | 2026-06-11 |
| [Architectural conformance — dependency rules and the adapter kit](proposed/2026-06-11-architectural-conformance.md) | 2026-06-11 |
| [API extractor reports](proposed/2026-06-11-api-extractor-reports.md) | 2026-06-11 |
| [Supply chain checks and vendor drift verification](proposed/2026-06-11-supply-chain-and-vendor-drift.md) | 2026-06-11 |
| [Agent Client Protocol (ACP) support for external editors](proposed/2026-06-14-acp-agent-client-protocol.md) | 2026-06-14 |
| [Multiplex concurrent ACP sessions over one connection](proposed/2026-06-14-acp-multi-session.md) | 2026-06-14 |
| [Optional Code Mode — model writes TypeScript against an SDK of all tools](proposed/2026-06-15-optional-code-mode.md) | 2026-06-15 |
| [Runtime schemas for the event vocabulary (Zod vs the merge-extensible-map pattern)](proposed/2026-06-16-typed-event-schemas.md) | 2026-06-16 |
| [Agent lifecycle and ownership seams](proposed/2026-06-18-agent-lifecycle-and-ownership-seams.md) | 2026-06-18 |

## Implemented

| Title | First proposed |
|---|---|
| [Vendor Cordis as source, not npm dependencies](implemented/2026-06-11-vendor-cordis-as-source.md) | 2026-06-11 |
| [Microkernel: extension via Cordis event taxonomy, one concrete loop](implemented/2026-06-11-microkernel-event-taxonomy.md) | 2026-06-11 |
| [Event-sourced sessions with derived message history](implemented/2026-06-11-event-sourced-sessions.md) | 2026-06-11 |
| [Provider-neutral content-block vocabulary owned by dsh-llm](implemented/2026-06-11-content-block-vocabulary.md) | 2026-06-11 |
| [Custom typed tool-schema DSL instead of schemastery](implemented/2026-06-11-custom-schema-dsl.md) | 2026-06-11 |
| [Tool schemas are part of the system-prompt assembly](implemented/2026-06-11-tool-schemas-in-prompt-assembly.md) | 2026-06-11 |
| [Mechanical quality gates over prose guidelines](implemented/2026-06-11-quality-gates.md) | 2026-06-11 |
| [tsdown for JS bundling instead of dumble](implemented/2026-06-11-tsdown-over-dumble.md) | 2026-06-11 |
| [Runtime arg validation at the model boundary](implemented/2026-06-11-runtime-arg-validation.md) | 2026-06-11 |
| [Dev-mode invariants over compile-time deep-readonly](implemented/2026-06-11-dev-invariants-over-deep-readonly.md) | 2026-06-11 |
| [Property-based testing for protocol-shaped code](implemented/2026-06-11-property-based-testing.md) | 2026-06-11 |
| [Doc-sync enforcement](implemented/2026-06-11-doc-sync-enforcement.md) | 2026-06-11 |
| [Markdown cross-link validity linting](implemented/2026-06-18-markdown-cross-link-lint.md) | 2026-06-18 |
| [Structured error taxonomy](implemented/2026-06-11-structured-error-taxonomy.md) | 2026-06-11 |
| [Capability seams — interface / implementation / consumer split](implemented/2026-06-13-capability-seams.md) | 2026-06-13 |
| [Two LLM adapters as a design-verification twin](implemented/2026-06-13-twin-llm-adapters.md) | 2026-06-13 |
| [Session persistence as an abstract service over `SessionEvent`](implemented/2026-06-14-session-persistence.md) | 2026-06-14 |
| [Every session event is enclosed in a turn](implemented/2026-06-15-turn-enclosure-invariant.md) | 2026-06-15 |
| [pnpm as the package manager instead of Yarn 4](implemented/2026-06-16-pnpm-over-yarn.md) | 2026-06-16 |
| [Rich ACP bash rendering — the terminal card (`_meta`) and command classification](implemented/2026-06-18-acp-terminal-and-tool-rendering.md) | 2026-06-18 |
| [ACP snapshot tests — record-once / replay-deterministic](implemented/2026-06-19-acp-snapshot-tests.md) | 2026-06-19 |
| [Real-API e2e in CI against the external DeepSeek API](implemented/2026-06-19-real-api-e2e-ci.md) | 2026-06-19 |
| [Drop the mutable session summary](implemented/2026-06-19-drop-mutable-session-summary.md) | 2026-06-19 |
| [Shared persistence write coordinator](implemented/2026-06-18-shared-persistence-write-coordinator.md) | 2026-06-18 |

## Rejected

| Title | First proposed |
|---|---|
| [Deep-readonly public surfaces](rejected/2026-06-11-immutable-public-surfaces.md) | 2026-06-11 |
