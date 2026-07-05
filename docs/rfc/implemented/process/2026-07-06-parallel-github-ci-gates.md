# RFC: Parallel GitHub CI gates

Status: implemented

## Problem

The keyless GitHub CI gates are mostly orthogonal: typecheck, lint, documentation freshness, coverage, snapshot replay, build, package-publication hygiene, demo smoke, and built-bin smoke fail for different reasons and do not need each other's runtime state. Running them as one ordered job makes the workflow wall clock equal the sum of those gates, and running the whole chain on multiple Node versions spends the same expensive repo-wide signal twice when the compatibility question is narrower than the full quality suite.

The hard part is the artifact boundary. `publint`, `verify-node-next-types`, and built-bin smoke tests need the built `lib/` outputs, while most gates only need source and dependencies. A blind fan-out either races those artifact consumers before `pnpm run build` has emitted declarations and bundles, or repeats the build in every artifact-dependent job.

## Decision

[CI](../../../../.github/workflows/ci.yml) uses Node 24 as the primary quality lane and fans out independent source-only work into matrix jobs. The `quality` matrix runs constraints, typecheck, lint, coverage, snapshot replay, and the echo-agent demo smoke independently. The `docs` matrix expands the `doc-sync` members into leaf jobs, including the RFC classification and format gates, so documentation failures report at the gate that failed instead of hiding behind one aggregate step.

Build output is produced once by a `build` job and uploaded as a short-retention artifact. Artifact consumers run behind that boundary: the `artifact-gate` matrix downloads the built package tree and runs `pnpm run hygiene` plus the built-bin smoke tests. Node-version compatibility stays explicit but narrower: the Node 26 lane runs typecheck and unit tests, while the full quality/documentation/artifact surface runs on the package engine floor.

Both CI workflows cache the pnpm store after enabling Corepack. The real-API e2e workflow also uses the shared `vitest.e2e.config.ts` bounded file pool (`DSH_E2E_MAX_WORKERS=4` in CI), so its speedup comes from dependency-cache reuse plus lower-level test-file fan-out instead of a separate GitHub job split.

## Alternatives considered

- **Keep the full serial chain in a Node matrix** - simplest to reason about, but it duplicates repo-wide gates that do not produce Node-version-specific signal and leaves every PR waiting for the sum of all gates.
- **Run every gate independently with no build artifact handoff** - maximizes fan-out, but the publication and built-bin checks are defined over built `lib/` outputs and would either fail, skip, or rebuild the same tree in several jobs.
- **Build inside every artifact-dependent job** - preserves correctness but shifts the bottleneck from the serial chain to repeated `tsc -b` and bundling work.
- **Use unbounded real-API e2e parallelism** - rejected because the suite includes many live model/tool scenarios; the worker pool needs an explicit `DSH_E2E_MAX_WORKERS` cap so CI and local runs can fan out without hiding quota or resource problems behind flaky rate-limit failures.

## Consequences

PR feedback arrives as many smaller checks rather than one large status. That makes failures easier to localize and lets independent gates finish as soon as their own runner is done, at the cost of more GitHub job setup overhead and a larger workflow file.

The split introduces a maintenance obligation: when `package.json` adds or removes a `doc-sync` member, the docs matrix needs the matching leaf job. That obligation is intentional because CI is now the parallel execution plan for the same gate vocabulary, not a separate quality policy.

The Node 26 signal is narrower than the primary Node 24 signal. It proves the source graph and unit suite on the newer runtime without doubling documentation, coverage, publication, and smoke checks whose failures are not expected to vary by Node minor version.
