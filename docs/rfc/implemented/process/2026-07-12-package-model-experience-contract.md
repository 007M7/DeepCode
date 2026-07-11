# RFC: Package Model Experience contract

Status: implemented

## Problem

A package README can explain APIs and runtime mechanics without answering the question that dominates an agent harness's behavior and cost: what from this package reaches a model request, under which conditions, and how long those tokens remain. The omission is especially hard to audit in a plugin architecture. A consumer may turn a backend result into a tool message, a policy plugin may replace success with an error, compaction may remove old history, and an agent-scoped registration may change one agent's prompt or schemas while leaving every other agent unchanged. Reading only the nominally model-facing packages therefore misses real context effects, while reading source across every dependency is too expensive for routine review.

## Decision

Every workspace package README ends with the canonical [Model Experience table](../../../AGENTS.md#package-model-experience), immediately before `## Known Limitations and Deferred Work`; a package on the no-limitations allowlist ends with Model Experience itself. Each row identifies a concrete request surface, says what the relevant model literally receives and when, and classifies the token effect. The default subject is the conversation model; a package that invokes an auxiliary model, such as a summarizer or search provider, names that request separately. Agent-scoped visibility is stated where it changes which agent receives a contribution.

Every package participates. A service seam, storage backend, test helper, or type-only library that contributes no prompt text, tool schema, message, or auxiliary request records zero direct tokens and names the consumer or control path through which it can still change model-visible material. This explicit negative contract prevents readers from having to infer whether the section was forgotten.

`verify-package-readme-model-experience` discovers packages from `packages/*/*/package.json`, requires one sibling README, the canonical final-section order, one exact `## Model Experience` heading and three-column table header, and at least one complete row. It runs in `doc-sync` and the parallel gate runner. The check owns shape and completeness; implementation review owns the truth of the prose.

## Alternatives considered

- **Document only packages that register prompts or tools** — rejected because backends, policy plugins, adapters, persistence, scoping, and compaction change the content or lifetime of tokens without owning a model-facing schema.
- **Generate one central context-cost catalog from source** — rejected because an AST can find registrations but cannot infer semantic conditions such as history retention, output truncation, parent-versus-child visibility, or an auxiliary model boundary. The package README is the implementation-local contract; a central copy would add another drift surface.
- **Require numeric token counts** — rejected because exact counts depend on the selected model tokenizer, adapter serialization, configuration, and runtime data. The stable contract is the growth shape: fixed per request, conditional per call, retained, replaced, capped, or zero-direct.
- **Allow zero-impact packages to omit the section** — rejected because absence is ambiguous between an audited zero and forgotten documentation. One explicit row is cheap and mechanically distinguishable.
- **Convention without a gate** — rejected because a repo-wide contract must also cover every future package; review memory cannot reliably detect an omitted README section.

## Consequences

A reviewer can start at any package and see its contribution to the conversation model, child models, and auxiliary calls without reconstructing the full plugin graph. Token-budget work can distinguish repeated request overhead from data-dependent history, and agent-scoped changes have an explicit documentation checkpoint. Package authors pay for one small table and must update it whenever model-visible behavior changes. The table deliberately does not promise provider-exact token counts; measurements remain model- and workload-specific, while the documented growth and visibility contract stays stable.
