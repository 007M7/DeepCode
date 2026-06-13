# RFC 001: Property-based testing for protocol-shaped code

Status: proposed

## Problem

Example-based tests pin the cases we thought of. The harness's core is protocol-shaped — chunk streams, event logs, schema conversion — where the input space is combinatorial and the interesting bugs live in interleavings nobody wrote an example for (the `streamBlocks` ordering bug survived 100% line coverage of the happy paths).

## Proposal

Adopt fast-check (vitest integration) with generators for our vocabulary:

- **BlockAssembler**: arbitrary chunk sequences (valid and malformed — duplicate indices, stragglers after block-end, missing block-start). Invariants: `flushReady() + flushRemaining() ≡ blocks()` in order; `streamBlocks ≡ generate().message.content`; memory bounded (partials map size ≤ distinct indices); idempotent re-assembly.
- **Session**: arbitrary event logs (seeded generators over SessionEventMap). Invariants: `deriveMessages` deterministic; replay-from-seed produces identical derivation; seq strictly monotonic; derived history unaffected by non-message events.
- **Schema DSL**: arbitrary SchemaSpecs. Invariants: generated JSON Schema's `required` array equals the `required: true` keys at every nesting level; conversion is total (never throws); generated args satisfying `InferArgs` validate against the generated schema (once RFC 005's validator exists — the two RFCs compose).
- **Inbox/loop**: arbitrary send/steer/abort schedules against a scripted adapter. Invariants: no message lost (every send/steer appears in the log exactly once), turn numbers strictly increase, status transitions follow idle→running→idle/disposed.

## Plan

One `tests/properties.spec.ts` per package; fast-check as devDependency; numRuns tuned so the suite stays under ~10s locally, with a nightly CI job running 100× the iterations. Failures persist their seed in the report so agents can reproduce deterministically.

## Risks

Generator quality determines value — invest in generators that produce *realistic-but-adversarial* streams, not uniform noise. Property flake from timeouts must be treated as a finding, not retried away.
