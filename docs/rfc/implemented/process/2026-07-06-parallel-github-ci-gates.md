# RFC: Parallel GitHub CI gates

Status: implemented

## Problem

The keyless GitHub CI gates are mostly orthogonal: typecheck, lint, documentation freshness, coverage, snapshot replay, build, package-publication hygiene, demo smoke, and built-bin smoke fail for different reasons and do not need each other's runtime state. Running them as one ordered command chain makes the workflow wall clock equal the sum of those gates, while splitting every leaf gate into its own GitHub job repeats checkout, Node setup, pnpm restore, and install work until orchestration overhead becomes the bottleneck.

The hard part is the artifact boundary. `publint`, `verify-node-next-types`, and built-bin smoke tests need the built `lib/` outputs, while most gates only need source and dependencies. A blind fan-out either races those artifact consumers before `pnpm run build` has emitted declarations and bundles, or repeats the build in every artifact-dependent job.

## Decision

[CI](../../../../.github/workflows/ci.yml) keeps the keyless workflow to two jobs. The Node 24 primary quality job installs once and runs `pnpm run check:ci`; the Node 26 compatibility job installs once and runs `pnpm run check:node-compat`.

`pnpm run check:ci` delegates to [scripts/run-gates.ts](../../../../scripts/run-gates.ts), an in-process scheduler with bounded concurrency (`DSH_GATE_CONCURRENCY`). It fans out source-only gates from the package-script vocabulary: constraints, typecheck, lint, coverage, snapshot replay, the echo-agent demo smoke, `doc-sync` leaf gates, module-graph freshness, and `knip`. The scheduler buffers each gate's output and prints a named result block with duration, so independent failures stay attributable inside one GitHub job log.

Generated `.sessions/` logs are ignored by lint, and the demo smoke waits for lint before creating and removing its session log. That dependency avoids racing ESLint's directory walk while coverage and snapshot replay remain the critical path.

Build output is produced once inside that Node 24 job. `build` waits for `typecheck` so concurrent `tsc -b` invocations do not share incremental state, and the artifact consumers (`publint`, `verify-node-next-types`, and built-bin smoke) declare a dependency on `build`. The CI coverage reporter is text-only while local coverage keeps the HTML report.

Both CI workflows cache the pnpm store after enabling Corepack. The real-API e2e workflow also uses the shared `vitest.e2e.config.ts` bounded file pool (`DSH_E2E_MAX_WORKERS=8` in CI), so its speedup comes from dependency-cache reuse plus lower-level test-file fan-out instead of a separate GitHub job split.

## Alternatives considered

- **Keep the full serial chain in a Node matrix** - simplest to reason about, but it duplicates repo-wide gates that do not produce Node-version-specific signal and leaves every PR waiting for the sum of all gates.
- **Run every gate as a separate GitHub job** - maximizes GitHub-visible fan-out, but it creates too many checks and pays repeated setup/install overhead for gates whose runtime is shorter than the runner preparation.
- **Upload build artifacts to artifact-dependent jobs** - preserves correctness across many jobs, but it adds artifact upload/download time and keeps the workflow wide when the artifact consumers can run behind a local dependency in the primary job.
- **Run `typecheck` and `build` concurrently** - exposes more work to the scheduler, but both commands invoke `tsc -b`; sharing incremental build state between them is a needless race for a small wall-clock gain.
- **Use unbounded real-API e2e parallelism** - rejected because the suite includes many live model/tool scenarios; the worker pool needs an explicit `DSH_E2E_MAX_WORKERS` cap so CI and local runs can fan out without hiding quota or resource problems behind flaky rate-limit failures.

## Consequences

PR feedback arrives as a few GitHub checks with structured per-gate log blocks inside the primary job. That keeps runner setup overhead low and the Actions UI compact, at the cost of losing one status check per leaf gate.

The split introduces a maintenance obligation: when `package.json` adds or removes a gate that belongs in CI, [scripts/run-gates.ts](../../../../scripts/run-gates.ts) needs the matching leaf. That obligation is intentional because the runner is the parallel execution plan for the same gate vocabulary, not a separate quality policy.

The Node 26 signal is narrower than the primary Node 24 signal. It proves the source graph and unit suite on the newer runtime without doubling documentation, coverage, publication, and smoke checks whose failures are not expected to vary by Node minor version.
