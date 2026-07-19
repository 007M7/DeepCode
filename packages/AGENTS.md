# AGENTS.md — Harness Packages

These package-specific rules supplement the repo-wide [conventions](../AGENTS.md#conventions).

- **Plugin export shape:** service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **Optional services use `ctx.get(name)`.** Reserve `ctx.<name>` for declared injections; the property proxy is topology-sensitive, while strict `ctx.get` reads the global service store ([postmortem](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- **Product-visible plugins require a non-unit REAL-composition test.** Hand-built `ctx.plugin(...)` suites are insufficient. Boot test-only `cordis.yml` through the Loader and app/process; mock only external/nondeterministic boundaries and assert model-visible, durable, or user-visible output. Keep opt-ins out of shipped defaults. [Policy](../docs/testing.md).
- **Typed same-process service and plugin calls are contracts, not serialization boundaries.** Prefer readonly borrowed values; materialize or defensively validate only at parser/config, queued, model/tool JSON, durable/file, worker, process, or wire boundaries.
- **Initiator-owned private chains derive, then capture.** Under `ctx.agents.withInitiator()`, recover the Agent at each orchestration entry, derive `agent.session`, and let operation-local helpers close over it. Keep `Agent` and `Session` explicit at lifecycle, session-log, service, authority, worker/process, persistence, and wire interfaces; do not widen a leaf helper from `Session` to `Context` merely to hide a parameter ([rationale](../docs/rfc/implemented/architecture/2026-07-15-agent-initiator-scope.md)).
- **Represent one asynchronous operation with one lifecycle controller or transaction.** Separate readiness, cancellation, disposal, reservation, or sentinel state requires an independent owner or settlement boundary; otherwise fold it while preserving rollback, callback containment, and quiescence.
- **Shape capability interfaces around all current consumers.** Keep tool-schema, Loader, UI, transport, and backend-specific behavior in the consumer or adapter; do not let one consumer dictate the interface ([capability-seam rationale](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).
- **Require a current owner and need.** Tie each abstraction, state machine, option, defensive copy, and compatibility path to a current contract or production consumer, and keep behavior in its owning plugin or service.
- **Require evidence for public choices.** Configurability does not justify an unsupported default, public operation set, format, or imported external concept. Use current-consumer evidence or relevant prior art; otherwise require an explicit value or defer the choice.
- **Write model-facing contracts from the model's perspective.** Prompts, tool schemas, results, and diagnostics contain only task-relevant concepts, not UI, transport, or implementation vocabulary. Pin stable model-visible text verbatim and dynamic behavior through snapshots or end-to-end coverage.
- **Enforce at the operation boundary that owns the decision.** Schema omission, prompt filtering, facades, wrappers, and listener order are not enforcement when direct or alternate callers can bypass them; test denial through the executor.
- **Publish state only at its commit point.** Emit each notification and update derived state only after the success boundary that makes it true; derive caches, prompts, UI echoes, replay, and query views from one authoritative source.
- **Apply bounds to the complete result.** Enforce byte, token, item, and time limits where the complete emitted or retained value, including wrappers and metadata, is known; test tiny and exact limits, oversized single chunks, and multibyte byte limits.
- **Registry contributions prove disposal.** Add the HMR-safety test required by the [testing policy](../docs/testing.md): dispose the contributing fiber and observe removal.

Naming notes:

- `src/types.ts` contains only types — no runtime code.
- Tests live at package level under `tests/`, not `src/__tests__/`.
- A package's README and JSDoc are part of the change: altered behavior (config keys, defaults, error codes, wire fields) updates them in the same commit. `doc-sync` gates what it can; apply [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for complete, concise prose and verify accuracy against code.
- Package READMEs document model/token effects using the [canonical Model Experience format](../docs/cookbook/adding-a-package.md#4-write-the-package-readme).
- Package READMEs put durable consumer gaps and non-obvious maintainer constraints under `## Known Limitations and Deferred Work`; ordinary cleanup stays in its TODO or RFC. Packages with none use a justified [allowlist entry](../scripts/verify-package-readme-limitations.ts) ([rationale](../docs/rfc/implemented/process/2026-07-10-readme-known-limitations-gate.md)).
