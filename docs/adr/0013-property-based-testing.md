# ADR 0013: Property-based testing for protocol-shaped code

Status: accepted (2026-06-14)

## Context

Example-based tests pin the cases we thought of. The harness's core is protocol-shaped — chunk streams, event logs, schema conversion, inbox scheduling — where the input space is combinatorial and the interesting bugs live in interleavings nobody wrote an example for. The motivating evidence: a `streamBlocks` ordering bug once survived 100% line coverage of the happy paths. Per-file 100% coverage proves every line ran, not that every interleaving is correct.

## Decision

Adopt `fast-check` (a root devDependency) with one `tests/properties.spec.ts` per protocol-shaped package, generators tuned for *realistic-but-adversarial* inputs (not uniform noise) and `numRuns` kept so the suite stays well under ~10s locally. Failures print a reproducible seed.

- **dsh-llm / BlockAssembler:** arbitrary chunk streams (valid + malformed: duplicate indices, stragglers, missing block-start). Invariants: `flushReady()+flushRemaining() ≡ blocks()` in order; the streamed prefix is always a prefix of final `blocks()`; partial count ≤ distinct indices; re-assembly idempotent.
- **dsh-session:** arbitrary event logs. Invariants: `deriveMessages` deterministic; replay-from-seed identical; seq strictly monotonic; non-message events never affect derived history; derived content is decoupled from the log.
- **dsh-tools:** arbitrary `SchemaSpec`. Invariants: JSON Schema `required` equals the `required:true` keys at every level; conversion total; **and the RFC 001↔005 composition** — generated args satisfying a spec pass `validateArgs`, and targeted corruptions (dropped required key, non-object top level) are rejected. This closes the validator/`InferArgs` drift risk from ADR 0011.
- **dsh-agent-loop:** arbitrary send schedules against a never-exhausting adapter, driven through the `agent/status` settle signal (no wall-clock sleeps). Invariants: no message lost; turn numbers strictly increase; status transitions stay on the legal machine.

## Consequences

- Generator quality is the value lever — the generators bias toward small index pools and short strings so collisions and interleavings are common.
- **It already paid off:** the BlockAssembler stream found a real bug — a duplicate `block-end` at the same index overwrote an already-flushed block, so the streamed prefix disagreed with final `blocks()`. Fixed (first close wins, matching the existing straggler rule) with a dedicated regression test.
- A property flake from a timeout is a finding, not something to retry away. The loop properties are deterministic by construction (settle on `agent/status`), so a hang is a real defect.
- Property tests supplement, not replace, the example tests that pin specific branches for the 100%-coverage gate.
