# RFCs

Proposals for substantial future work — reviewed before implementation, unlike ADRs (which record decisions already made). Each RFC groups a related set of ideas from the quality/robustness proposal (2026-06-11); statuses move proposed → accepted → implemented (then usually graduate to an ADR).

| # | Title | Status |
|---|---|---|
| [001](001-property-based-testing.md) | Property-based testing for protocol-shaped code | implemented |
| [002](002-mutation-testing.md) | Mutation testing as the coverage counterweight | proposed |
| [003](003-deterministic-and-stress-testing.md) | Deterministic tests + replay invariant fixture + race stress | proposed |
| [004](004-architectural-conformance.md) | Architectural rules: dependency-cruiser, adapter conformance kit | proposed |
| [005](005-runtime-validation-and-error-taxonomy.md) | Runtime arg validation, structured error taxonomy, dev-mode invariants | implemented |
| [006](006-doc-sync-and-api-reports.md) | Doc-sync enforcement and API extractor reports | implemented (pts 1-2; pt 3 deferred) |
| [007](007-supply-chain-and-vendor-drift.md) | Supply chain checks and vendor drift verification | proposed |
| [008](008-immutable-public-surfaces.md) | Deep-readonly public surfaces | implemented (revised) |
| [009](009-session-persistence-and-resumability.md) | Durable session persistence — abstract, append-only, event-based store | proposed |
| [010](010-acp-agent-client-protocol.md) | Agent Client Protocol (ACP) support for external editors | proposed |
| [011](011-acp-multi-session.md) | Multiplex concurrent ACP sessions over one connection | proposed |
| [012](012-optional-code-mode.md) | Optional Code Mode — model writes TypeScript against an SDK of all tools | proposed |
| [013](013-typed-event-schemas.md) | Runtime schemas for the event vocabulary (Zod vs the merge-extensible-map pattern) | proposed |
