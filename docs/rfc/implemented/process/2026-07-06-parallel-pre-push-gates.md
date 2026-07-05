# RFC: Parallel pre-push gates

Status: implemented

## Problem

The pre-push hook is the last local checkpoint before a branch leaves the machine, so its wall clock directly shapes whether contributors keep it enabled and trust its signal. Lefthook already runs top-level jobs in parallel, but aggregate jobs such as `pnpm run hygiene` and `pnpm run doc-sync` hide long sequential chains inside one job. The hook can therefore be configured as parallel while still waiting on serial subcommands whose members are independent.

`publint` has the same shape one level lower. Each package is linted independently against its own manifest and built output, but the runner loops through every package in order. On this repo that makes one package-publication gate consume time proportional to the number of packages even though the checks do not share mutable state.

## Decision

[lefthook.yml](../../../../lefthook.yml) expands the pre-push hook into leaf jobs for the unit suite, snapshot suite, `hygiene` members, `doc-sync` members, and module-graph freshness. The leaf list keeps the same gate vocabulary as the package scripts, including RFC classification and RFC format, but lets lefthook schedule the independent checks concurrently and report each failure by its own job name.

[scripts/publint-all.ts](../../../../scripts/publint-all.ts) discovers the package list from `packages/<group>/<pkg>` and runs `publint` with a worker pool sized from `availableParallelism()`. `DSH_PUBLINT_CONCURRENCY` can cap or raise the worker count for local machines and CI runners with different resource profiles. Results are buffered per package and printed in deterministic package order, so parallel execution does not scramble each package's log block.

The aggregate package scripts remain the source of truth for CI and ad hoc local runs. The hook is a parallel execution plan over their member gates, not a replacement vocabulary.

## Alternatives considered

- **Keep aggregate `hygiene` and `doc-sync` jobs in the hook** - simpler config, but it leaves most of the pre-push wall clock inside serial command chains that lefthook cannot see or schedule.
- **Background subcommands inside shell scripts** - can parallelize work, but it loses lefthook's job names, per-job timing, and failure grouping, and makes signal handling harder to reason about.
- **Declare one publint lefthook job per package** - exposes maximum parallelism, but it turns the hook into a hand-maintained package inventory that drifts exactly when new packages are added.
- **Run publint with unbounded concurrency** - minimizes elapsed time on small machines only by gambling with process count, memory pressure, package tarball creation, and readable logs.

## Consequences

The hook's critical path becomes the slowest real gate instead of the sum of hidden gate chains. Lefthook reports per-job timing for every leaf gate, so a slow local checkpoint points at the gate that actually dominates the run.

The hook file is longer and must track the member list of `hygiene` and `doc-sync`. That duplication is acceptable because the purpose of the hook is scheduling, while `package.json` remains the command vocabulary that CI and humans call directly.

`publint-all.ts` becomes asynchronous code and buffers command output instead of inheriting stdio live. The payoff is package-level parallelism with stable output order and one environment variable for resource tuning.
