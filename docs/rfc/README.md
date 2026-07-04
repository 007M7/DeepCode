# RFCs

One kind of design doc lives here. An **RFC** records a decision or proposal that shapes this codebase — the *why* and *what we gave up*, the parts code and docs can't carry. (Earlier this split into separate "ADR" and "RFC" trees; they were unified, since most ADRs were simply implemented RFCs.)

## Layout and naming

Every RFC has two axes, both encoded in its **path** — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the RFC's status, and an RFC moves between folders as that status changes:
  - **`proposed/`** — proposals reviewed before implementation; not yet built (or only partly).
  - **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is **kept current with what actually shipped**: when the code later moves a file, renames a package, or changes a key/default, the RFC is updated in the same change to match (facts only — paths, names, structure — not the decision itself). See [implemented/AGENTS.md](implemented/AGENTS.md).
  - **`rejected/`** — the proposal was considered and declined. Kept for the record so the rejection isn't re-litigated.
- **Class** (the nested folder) is the *kind* of decision — see [Classification](#classification) below.

The date in the filename is when the topic was **first proposed** (per git history). Cross-references between RFCs use relative markdown links (`[topic](../../implemented/architecture/2026-…-….md)`) — never bare prose or numbers — so they are mechanically checkable and survive moves between folders.

## Classification

Each RFC is filed under exactly one **class** — the kind of decision it records. The class is encoded in the path (the folder *is* the label, so a file's location declares its class) and the set is **closed**: `scripts/verify-rfc-classification.ts` rejects any folder outside the set and asserts this index lists every RFC under the heading matching its path. Adding a new class means amending that gate and this section, not just dropping a new folder. See [the classification RFC](implemented/process/2026-06-20-rfc-classification.md) for why the taxonomy is path-encoded and gated.

| Class | What it covers |
|---|---|
| `feature` | A new user- or model-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about the **shipped source** — how packages relate, what the runtime vocabulary is. |
| `process` | Tooling, policy, or workflow **around** the code — gates, the package manager, vendoring — not runtime behavior. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is the surrounding tooling and workflow. (`refactor` is deliberately absent — it overlaps `simplification`, whose discriminator, "does observable behavior change?", already covers it.)

## When to write one

Write an RFC when a decision is **durable** (it shapes the codebase beyond a single function or package), **contested** (there was a real alternative a reasonable engineer might have chosen), and **surprising** (a future reader would otherwise ask "why on earth is it done this way?"). A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`. Pick the class folder that matches the decision (see [Classification](#classification)).

Do NOT write one for a mechanical or local choice (a variable name, a one-file refactor), for anything already enforced and explained by a gate or a convention in AGENTS.md, or for a still-provisional decision tagged `TODO(...)` in the code — record those as TODOs and promote to an RFC only once they settle. An RFC is never edited into a *different decision*: supersede it with a new one and cross-link. (Editing an `implemented/` RFC to track where its already-made decision now *lives* — a moved file, a renamed package — is not a different decision and is required, not forbidden; see [implemented/AGENTS.md](implemented/AGENTS.md).)

## Proposed

### Feature

| Title | First proposed |
|---|---|
| [Agent Client Protocol (ACP) support for external editors](proposed/feature/2026-06-14-acp-agent-client-protocol.md) | 2026-06-14 |
| [Multiplex concurrent ACP sessions over one connection](proposed/feature/2026-06-14-acp-multi-session.md) | 2026-06-14 |
| [Optional Code Mode — model writes TypeScript against an SDK of all tools](proposed/feature/2026-06-15-optional-code-mode.md) | 2026-06-15 |
| [Pre-tool input rewrite — a consistent design](proposed/feature/2026-06-30-pre-tool-input-rewrite.md) | 2026-06-30 |

### Simplification

| Title | First proposed |
|---|---|
| [Unify the agent id and the session id](proposed/simplification/2026-06-20-unify-agent-and-session-id.md) | 2026-06-20 |

### Architecture

| Title | First proposed |
|---|---|
| [Runtime schemas for the event vocabulary (Zod vs the merge-extensible-map pattern)](proposed/architecture/2026-06-16-typed-event-schemas.md) | 2026-06-16 |
| [Extract a generic long-running tool runtime](proposed/architecture/2026-06-20-generic-long-running-tool-runtime.md) | 2026-06-20 |

### Process

| Title | First proposed |
|---|---|
| [Architectural conformance — dependency rules and the adapter kit](proposed/process/2026-06-11-architectural-conformance.md) | 2026-06-11 |
| [API extractor reports](proposed/process/2026-06-11-api-extractor-reports.md) | 2026-06-11 |
| [Supply chain checks and vendor drift verification](proposed/process/2026-06-11-supply-chain-and-vendor-drift.md) | 2026-06-11 |
| [Discover package inventories instead of maintaining static lists](proposed/process/2026-06-20-discover-package-inventory.md) | 2026-06-20 |

### Testing

| Title | First proposed |
|---|---|
| [Mutation testing as the coverage counterweight](proposed/testing/2026-06-11-mutation-testing.md) | 2026-06-11 |
| [Deterministic tests, the replay invariant fixture, and race stress](proposed/testing/2026-06-11-deterministic-and-stress-testing.md) | 2026-06-11 |

## Implemented

### Feature

| Title | First proposed |
|---|---|
| [Filesystem tool schemas — model-facing read/write/edit shapes](implemented/feature/2026-06-17-filesystem-tool-schemas.md) | 2026-06-17 |
| [Rich ACP bash rendering — the terminal card (`_meta`) and command classification](implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md) | 2026-06-18 |
| [Compaction as a capability seam (abstract contract + basic backend)](implemented/feature/2026-06-18-compaction-capability-seam.md) | 2026-06-18 |
| [Subagent capability seam](implemented/feature/2026-06-21-subagent-capability-seam.md) | 2026-06-21 |
| [ACP subagent backend (out-of-process delegation)](implemented/feature/2026-06-22-acp-subagent-backend.md) | 2026-06-22 |
| [The `todo_write` tool — model task list as event-sourced session state](implemented/feature/2026-06-29-todo-write-tool.md) | 2026-06-29 |
| [Interception seams — the typed-Decision surface a hook programs against](implemented/feature/2026-06-30-interception-seams.md) | 2026-06-30 |
| [Subagent lifecycle enrichment — lastAssistantMessage (observe-only)](implemented/feature/2026-06-30-subagent-observe-enrich.md) | 2026-06-30 |
| [dsh-hook-protocol — the shared Claude Code / Codex hook wire-protocol core](implemented/feature/2026-06-30-hook-protocol-lib.md) | 2026-06-30 |

### Simplification

| Title | First proposed |
|---|---|
| [Drop the mutable session summary](implemented/simplification/2026-06-19-drop-mutable-session-summary.md) | 2026-06-19 |
| [Drop unconsumed assembled LLM convenience surfaces](implemented/simplification/2026-06-20-drop-unconsumed-llm-assembled-surfaces.md) | 2026-06-20 |
| [Drop the unconsumed `llm/adapter-change` event](implemented/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md) | 2026-06-20 |
| [Prune dead methods from the persistence seam](implemented/simplification/2026-06-20-prune-dead-seam-methods.md) | 2026-06-20 |
| [Keep one public stop primitive](implemented/simplification/2026-06-20-public-agent-stop-surface.md) | 2026-06-20 |
| [Fold trace-only session facts into load-bearing events](implemented/simplification/2026-06-20-collapse-trace-only-session-events.md) | 2026-06-20 |
| [Stop mirroring durable boundaries as agent events](implemented/simplification/2026-06-20-remove-agent-boundary-mirror-events.md) | 2026-06-20 |
| [Split the filesystem seam — provider text mutations plus the `dsh-fs-policy` plugin](implemented/simplification/2026-06-26-fsspec-style-fs-seam.md) | 2026-06-26 |

### Architecture

| Title | First proposed |
|---|---|
| [Microkernel: extension via Cordis event taxonomy, one concrete loop](implemented/architecture/2026-06-11-microkernel-event-taxonomy.md) | 2026-06-11 |
| [Event-sourced sessions with derived message history](implemented/architecture/2026-06-11-event-sourced-sessions.md) | 2026-06-11 |
| [Provider-neutral content-block vocabulary owned by dsh-llm](implemented/architecture/2026-06-11-content-block-vocabulary.md) | 2026-06-11 |
| [Custom typed tool-schema DSL instead of schemastery](implemented/architecture/2026-06-11-custom-schema-dsl.md) | 2026-06-11 |
| [Tool schemas are part of the system-prompt assembly](implemented/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md) | 2026-06-11 |
| [Runtime arg validation at the model boundary](implemented/architecture/2026-06-11-runtime-arg-validation.md) | 2026-06-11 |
| [Dev-mode invariants over compile-time deep-readonly](implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md) | 2026-06-11 |
| [Structured error taxonomy](implemented/architecture/2026-06-11-structured-error-taxonomy.md) | 2026-06-11 |
| [Capability seams — interface / implementation / consumer split](implemented/architecture/2026-06-13-capability-seams.md) | 2026-06-13 |
| [Two LLM adapters as a design-verification twin](implemented/architecture/2026-06-13-twin-llm-adapters.md) | 2026-06-13 |
| [Session persistence as an abstract service over `SessionEvent`](implemented/architecture/2026-06-14-session-persistence.md) | 2026-06-14 |
| [Every session event is enclosed in a turn](implemented/architecture/2026-06-15-turn-enclosure-invariant.md) | 2026-06-15 |
| [Filesystem capability seam — ctx.fs, local backend, and model-facing filesystem tools](implemented/architecture/2026-06-17-filesystem-capability-seam.md) | 2026-06-17 |
| [Shared persistence write coordinator](implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md) | 2026-06-18 |
| [Agent lifecycle and ownership seams](implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md) | 2026-06-18 |
| [Session surface — a linked list over the event log for LLM message derivation](implemented/architecture/2026-06-18-session-surface.md) | 2026-06-18 |
| [Reorganize packages into a modular hierarchy](implemented/architecture/2026-06-20-package-hierarchy.md) | 2026-06-20 |
| [Branded IDs everywhere they belong](implemented/architecture/2026-06-20-branded-ids.md) | 2026-06-20 |
| [Extract example apps into packages](implemented/architecture/2026-06-20-extract-example-app-packages.md) | 2026-06-20 |
| [Web capability seam — provider registry and model-facing web tools](implemented/architecture/2026-06-24-web-capability-seam.md) | 2026-06-24 |
| [Make `dsh-fs-policy` an event-gate plugin, not a method interface](implemented/architecture/2026-06-26-file-context-as-event-gate.md) | 2026-06-26 |
| [Event-domain semantics — session is the fact log, agent is the live surface](implemented/architecture/2026-06-30-event-domain-semantics.md) | 2026-06-30 |
| [stdin + extra env on the bash seam](implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-surface.md) | 2026-06-30 |
| [Resolve filesystem paths against the caller's session cwd](implemented/architecture/2026-07-02-fs-per-session-cwd.md) | 2026-07-02 |
| [Tagged render-intent union for tool-call presentation](implemented/architecture/2026-07-02-tool-render-intent-union.md) | 2026-07-02 |
| [Result-time applied-hunk diffs for file mutations](implemented/architecture/2026-07-02-result-time-applied-hunk-diffs.md) | 2026-07-02 |
| [Add direct directory listing to the filesystem seam](implemented/architecture/2026-07-03-filesystem-directory-listing-seam.md) | 2026-07-03 |

### Process

| Title | First proposed |
|---|---|
| [Vendor Cordis as source, not npm dependencies](implemented/process/2026-06-11-vendor-cordis-as-source.md) | 2026-06-11 |
| [Mechanical quality gates over prose guidelines](implemented/process/2026-06-11-quality-gates.md) | 2026-06-11 |
| [tsdown for JS bundling instead of dumble](implemented/process/2026-06-11-tsdown-over-dumble.md) | 2026-06-11 |
| [Doc-sync enforcement](implemented/process/2026-06-11-doc-sync-enforcement.md) | 2026-06-11 |
| [pnpm as the package manager instead of Yarn 4](implemented/process/2026-06-16-pnpm-over-yarn.md) | 2026-06-16 |
| [TSC-first build and one tsconfig](implemented/process/2026-06-17-ts-build-config.md) | 2026-06-17 |
| [Markdown cross-link validity linting](implemented/process/2026-06-18-markdown-cross-link-lint.md) | 2026-06-18 |
| [Core-data-structures catalog and the `ts type-equiv` drift gate](implemented/process/2026-06-20-core-data-structures-catalog.md) | 2026-06-20 |
| [Generated cordis events + services catalog](implemented/process/2026-06-20-generated-cordis-catalog.md) | 2026-06-20 |
| [Classify RFCs by kind via path-encoded subdirectories](implemented/process/2026-06-20-rfc-classification.md) | 2026-06-20 |
| [Generated tool-schema catalog (boot-and-harvest)](implemented/process/2026-07-02-tool-schema-catalog.md) | 2026-07-02 |
| [Bilingual documentation via paired sibling files and a pairing gate](implemented/process/2026-07-02-bilingual-docs-and-pairing-gate.md) | 2026-07-02 |

### Testing

| Title | First proposed |
|---|---|
| [Property-based testing for protocol-shaped code](implemented/testing/2026-06-11-property-based-testing.md) | 2026-06-11 |
| [ACP snapshot tests — record-once / replay-deterministic](implemented/testing/2026-06-19-acp-snapshot-tests.md) | 2026-06-19 |
| [Real-API e2e in CI against the external DeepSeek API](implemented/testing/2026-06-19-real-api-e2e-ci.md) | 2026-06-19 |
| [Use `session.jsonl` as the only snapshot session-log artifact](implemented/testing/2026-06-20-remove-redundant-snapshot-log-goldens.md) | 2026-06-20 |
| [Per-session snapshot replay for nested agents](implemented/testing/2026-06-22-subagent-snapshot-replay.md) | 2026-06-22 |
| [Persist the seed boundary so fork-child replay routes correctly](implemented/testing/2026-06-22-fork-child-replay-seed-boundary.md) | 2026-06-22 |
| [Record fork and mixed spawn+fork snapshot scenarios](implemented/testing/2026-06-22-fork-snapshot-scenarios.md) | 2026-06-22 |

## Rejected

### Simplification

| Title | First proposed |
|---|---|
| [Persist assembled assistant messages, not stream chunks](rejected/simplification/2026-06-20-assembled-assistant-messages-only.md) | 2026-06-20 |
| [Drop ACP session/load until resume has a product shape](rejected/simplification/2026-06-20-drop-acp-session-load.md) | 2026-06-20 |
| [Drop ACP terminal `_meta` rendering](rejected/simplification/2026-06-20-drop-acp-terminal-meta.md) | 2026-06-20 |
| [Drop bash full-output spill files](rejected/simplification/2026-06-20-drop-bash-output-spill-files.md) | 2026-06-20 |
| [Drop durable step boundary events](rejected/simplification/2026-06-20-drop-durable-step-boundaries.md) | 2026-06-20 |
| [Drop unused session lineage metadata](rejected/simplification/2026-06-20-drop-unused-session-lineage.md) | 2026-06-20 |
| [Fold the persistence interface into dsh-session](rejected/simplification/2026-06-20-fold-session-persistence-interface.md) | 2026-06-20 |
| [Collapse tool-owned UI presentation](rejected/simplification/2026-06-20-generic-tool-rendering.md) | 2026-06-20 |
| [Retire mid-turn steering](rejected/simplification/2026-06-20-retire-mid-turn-steering.md) | 2026-06-20 |
| [Return the ACP bridge to one live session per connection](rejected/simplification/2026-06-20-single-session-acp-bridge.md) | 2026-06-20 |
| [Truncate interrupted final turns on load](rejected/simplification/2026-06-20-truncate-interrupted-turns.md) | 2026-06-20 |

### Architecture

| Title | First proposed |
|---|---|
| [Deep-readonly public surfaces](rejected/architecture/2026-06-11-immutable-public-surfaces.md) | 2026-06-11 |
| [Make the shared example base providerless](rejected/architecture/2026-06-20-providerless-example-base.md) | 2026-06-20 |
