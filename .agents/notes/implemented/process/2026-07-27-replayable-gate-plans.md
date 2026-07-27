# Agent Note: Validated, self-describing, replayable gate plans

Status: implemented

English | [中文](2026-07-27-replayable-gate-plans.zh.md)

## Problem

Repository aggregates need to fail before execution when their dependency graph is invalid. Without validation, an empty aggregate can succeed, duplicate gate IDs can overwrite scheduler state, and missing or cyclic dependencies can appear as generic skips after unrelated work has already run.

Operators also need the scheduler-owned environment and dependency context for a failed command. The Node 24 consumer job instead owned a separate shell process pool, duplicating commands, concurrency, environment, and failure collection while allowing later commands to consume restored artifacts before publint and built-package invariant checks established their public and runtime-closure contracts.

## Decision

[`scripts/run-gates.ts`](../../../../scripts/run-gates.ts) constructs a complete `GatePlan` before execution and validates that it is non-empty, every ID is unique and replay-safe, every dependency exists, and the graph is acyclic. `executeGatePlan()` repeats validation at the process boundary, so an invalid injected plan cannot start a child. The empty `pre-push` mode is absent; Git hooks retain their separate narrow contract.

Every mode supports deterministic `--list` output and a versioned stable `--list --json` object. Machine consumers invoke `pnpm --silent run <owning-script> -- --list --json`; `--silent` removes pnpm's outer command banner so stdout is exactly one JSON object. Both views expose canonical gate order, IDs, display commands, dependencies, blocking disposition, the plan-owned worker ceiling, and scheduler-owned environment operations. Gate-level spawn overrides remain declarative until spawn and support only the forms current plans use: setting a value or appending one with a space. Inspection serializes those operations without resolving them against inherited values; values under secret-like declared names are redacted.

`--only <gate-id>` runs the named gate with its complete transitive dependency closure in canonical plan order. Its banner identifies the run as partial diagnostic evidence and names the complete owning package script. Every failed or skipped gate prints the cross-platform replay command `pnpm run <owning-script> -- --only <gate-id>`, which restores dependency and environment semantics through the scheduler.

The scheduler announces each start, buffers a child's stdout and stderr until that gate settles, and then emits one attributable result while unrelated gates continue. Failure blocks include the display command, redacted scheduler-owned environment operations, orthogonal exit and signal outcomes, complete child output, and the replay command; successful child output remains suppressed unless `DSH_GATE_VERBOSE=1`. Child output is not persisted.

The `check:ci:consumers` mode owns the Node 24 consumer job's seven top-level commands and a plan-visible seven-worker default and ceiling. That default preserves the prior process pool even on a host reporting fewer CPUs; `DSH_GATE_CONCURRENCY` may request fewer workers but cannot exceed the plan ceiling. Publint first validates the manifest-declared public artifact view, including the existence of exported files; `verify-built-package-invariants` then depends on publint and validates every compiled invariant plus its declared runtime closure and the restored Loader bundle. Snapshot, NodeNext type checks, and built-bin smokes depend on both stages through `verify-built-package-invariants`. Source compatibility smokes may overlap the validation stages; lint and duplication wait for built-package invariant validation so ESLint cannot traverse its transient staged package views, then may overlap downstream consumers.

## Verification

[`scripts/run-gates.spec.ts`](../../../../scripts/run-gates.spec.ts) proves invalid plans cannot reach the injected executor, dependency closure is complete, list order and JSON fields are stable, direct and symlinked entries emit one parseable JSON object, replay text is portable, environment resolution is deferred to spawn, signal termination remains distinct from exit status, and a settled failure is observed before an unrelated gate finishes. Its consumer-plan case pins the seven-command inventory, worker default and ceiling, and restored-build validation dependencies. [`scripts/publint-all.spec.ts`](../../../../scripts/publint-all.spec.ts) proves a missing public export fails the first stage. The CI workflow invokes only `pnpm run check:ci:consumers` for that process pool.

## Alternatives considered

**Keep the scheduler internal and document commands beside the workflow.** This leaves two executable inventories to drift and cannot reveal the plan that actually ran.

**Add validation without discovery or focused replay.** This closes fail-open graph defects, but operators still have to reconstruct dependencies and hidden overrides from TypeScript during an incident.

**Adopt a general-purpose task orchestrator.** The repository scheduler already owns buffering, dependency ordering, cross-platform shell-free spawning, and blocking disposition. Replacing it adds a dependency and migration without deleting a distinct local abstraction.

**Persist child output under the repository.** Runner-local files disappear with hosted CI jobs unless uploaded, can contain sensitive child data, and require a filesystem ownership and cleanup contract unrelated to plan replay. The console remains the authoritative diagnostic record.

**Stream concurrent child output live.** Unprefixed streams interleave and lose attribution. Emitting each complete block as soon as its gate settles preserves attribution without waiting for unrelated gates.

## Consequences

The scheduler owns a small CLI and a versioned JSON schema that must evolve deliberately with the gate model. Focused replay is faster to diagnose but is not complete evidence, so the CLI labels it explicitly and always names the owning aggregate.

Later artifact consumers and lint start only after publint and built-package invariant validation, so ESLint cannot traverse the verifier's transient staged views and those downstream gates may overlap one another. Source compatibility smokes still overlap both validation stages; a missing public export or broken compiled-invariant closure fails before it can produce misleading downstream results.

Buffered output is coherent and attributable, but no progress from a long-running child appears until that child settles, and the runner retains no second copy after the console is lost. Operators trade live interleaving and durable local output for a smaller scheduler whose diagnostic state is the inspected plan, settlement block, and replay command.
