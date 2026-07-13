# RFC: Package Model Experience contract

Status: implemented

## Problem

A package README can explain APIs and runtime mechanics without answering the question that dominates an agent harness's behavior and cost: what from this package reaches a model request, under which conditions, and how long those tokens remain. The omission is especially hard to audit in a plugin architecture. A consumer may turn a backend result into a tool message, a policy plugin may replace success with an error, compaction may remove old history, and an agent-scoped registration may change one agent's prompt or schemas while leaving every other agent unchanged. Reading only the nominally model-facing packages therefore misses real context effects, while reading source across every dependency is too expensive for routine review.

## Decision

Every workspace package README ends with the canonical [Model Experience section](../../../cookbook/adding-a-package.md#4-write-the-package-readme), immediately before `## Known Limitations and Deferred Work`; a package on the no-limitations allowlist ends with Model Experience itself. Packages with direct, multi-surface, conditional, capped, or lifetime effects use the three-column table. Each row identifies a concrete request surface, says what the relevant model literally receives and when, and classifies the token effect. Stable source literals are quoted verbatim, with named placeholders only for interpolated values; summaries are reserved for data-dependent payloads, provider-owned text, or schemas too large to reproduce. The default subject is the conversation model; a package that invokes an auxiliary model, such as a summarizer or search provider, names that request separately. Agent-scoped visibility is stated where it changes which agent receives a contribution. Prompt text and tool schemas are described separately whenever configuration or scoping can hide one without the other.

Every package participates. A package with no model-context effect, or one simple effect rendered entirely by another package, can join the verifier's audited sentence allowlist. It then uses exactly one sentence beginning `None, as ` or `Indirectly, through ` instead of stretching a negative fact across a three-column table. Implementations that shape results, caps, history, lifetimes, or more than one request surface keep the table even when they add zero direct prompt tokens.

`verify-package-readme-model-experience` discovers packages from `packages/*/*/package.json`, requires one sibling README and the canonical final-section order, and validates one of two package-classified bodies outside fenced code. An allowlisted package must carry exactly one sentence with its assigned prefix; every other package must carry only the exact three-column header and at least one complete row. It runs in `doc-sync` and the parallel gate runner. The check owns package classification, structural presence, shape, and order; implementation review owns coverage and the truth of the prose.

## Alternatives considered

- **Document only packages that register prompts or tools** — rejected because backends, policy plugins, adapters, persistence, scoping, and compaction change the content or lifetime of tokens without owning a model-facing schema.
- **Generate one central context-cost catalog from source** — rejected because an AST can find registrations but cannot infer semantic conditions such as history retention, output truncation, parent-versus-child visibility, or an auxiliary model boundary. The package README is the implementation-local contract; a central copy would add another drift surface.
- **Require numeric token counts** — rejected because exact counts depend on the selected model tokenizer, adapter serialization, configuration, and runtime data. The stable contract is the growth shape: fixed per request, conditional per call, retained, replaced, capped, or zero-direct.
- **Allow zero-impact packages to omit the section** — rejected because absence is ambiguous between an audited zero and forgotten documentation. One explicit sentence is cheap and mechanically distinguishable.
- **Require the full table for audited zero or simple indirect packages** — rejected because it spreads one fact across three cells and encourages repetitive prose. A gated sentence preserves explicit coverage without the ceremony.
- **Convention without a gate** — rejected because a repo-wide contract must also cover every future package; review memory cannot reliably detect an omitted README section.

## Consequences

A reviewer can start at any package and see its contribution to the conversation model, child models, and auxiliary calls without reconstructing the full plugin graph. Token-budget work can distinguish repeated request overhead from data-dependent history, and agent-scoped changes have an explicit documentation checkpoint. Package authors pay for one small table or one classified sentence and must update it whenever model-visible behavior changes. Tables deliberately do not promise provider-exact token counts; measurements remain model- and workload-specific, while the documented growth and visibility contract stays stable.
