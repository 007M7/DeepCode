# Architecture Decision Records

Short, immutable records of the *why* behind decisions that shape this codebase. Code and docs say what the system does; ADRs say why it does it that way and what we gave up.

Format: one file per decision, numbered, with Status / Context / Decision / Consequences. An ADR is never edited into a different decision — supersede it with a new one and cross-link.

## When to write an ADR

Write one when a decision is all three of: **durable** (it shapes the codebase beyond a single function or package), **contested** (there was a real alternative you rejected, and a reasonable engineer might have chosen it), and **surprising** (a future reader would otherwise ask "why on earth is it done this way?"). The ADR captures the *why* and *what we gave up* — the parts code and docs can't.

Do NOT write an ADR for: a mechanical or local choice (a variable name, a one-file refactor); anything already enforced and explained by a gate or a convention in AGENTS.md; or a still-provisional decision tagged `TODO(...)` in the code — record those as TODOs and promote to an ADR only once they settle. When in doubt, the test is the "why on earth" question: if the code alone would mislead a careful reader about intent, write the ADR.

| # | Title | Status |
|---|---|---|
| [0001](0001-vendor-cordis-as-source.md) | Vendor Cordis as source, not npm dependencies | accepted |
| [0002](0002-microkernel-event-taxonomy.md) | Microkernel: extension via Cordis event taxonomy, one concrete loop | accepted |
| [0003](0003-event-sourced-sessions.md) | Event-sourced sessions with derived message history | accepted |
| [0004](0004-own-content-block-vocabulary.md) | Provider-neutral content-block vocabulary owned by dsh-llm | accepted |
| [0005](0005-custom-schema-dsl-over-schemastery.md) | Custom typed tool-schema DSL instead of schemastery | accepted |
| [0006](0006-tool-schemas-in-prompt-assembly.md) | Tool schemas are part of the system-prompt assembly | accepted |
| [0007](0007-quality-gates.md) | Mechanical quality gates over prose guidelines | accepted |
| [0008](0008-tsdown-over-dumble.md) | tsdown for JS bundling instead of dumble | accepted |
| [0009](0009-capability-seams.md) | Capability seams — interface / implementation / consumer split | accepted |
| [0010](0010-twin-llm-adapters.md) | Two LLM adapters as a design-verification twin | accepted |
| [0011](0011-runtime-arg-validation.md) | Runtime arg validation at the model boundary | accepted |
| [0012](0012-dev-invariants-over-deep-readonly.md) | Dev-mode invariants over compile-time deep-readonly | accepted |
| [0013](0013-property-based-testing.md) | Property-based testing for protocol-shaped code | accepted |
| [0014](0014-doc-sync-enforcement.md) | Doc-sync enforcement (doc code blocks + event taxonomy) | accepted |
| [0015](0015-structured-error-taxonomy.md) | Structured error taxonomy (HarnessError base) | accepted |
