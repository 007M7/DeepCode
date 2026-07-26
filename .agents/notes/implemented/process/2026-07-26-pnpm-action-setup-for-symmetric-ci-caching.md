# Agent Note: Use pnpm/action-setup for symmetric CI pnpm caching

Status: implemented

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

Five workflows repeated a hand-rolled three-step pnpm setup — `corepack enable`, `pnpm store path --silent >> $GITHUB_OUTPUT`, then `actions/cache@v4` keyed on `pnpm-lock.yaml`: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat, serial-linux, and benchmark jobs of `ci.yml` (~40–60 YAML lines total). The maintained equivalent — `pnpm/action-setup@v4` (reads `packageManager` from package.json) plus `actions/setup-node` with `cache: pnpm` — was already proven in-repo in `landlock-run.yml`, and also insulates against corepack's removal from newer Node distributions.

## Decision

The symmetric-cache setups use `pnpm/action-setup@v4` followed by `actions/setup-node` with `cache: pnpm`, the `landlock-run.yml` pattern: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat and two benchmark jobs of `ci.yml`. The larger-runner benchmark keeps its store cache Linux-only through a conditional `cache:` input, mirroring the required Windows job's deliberate skip; the consolidated benchmark caches on both platforms as before.

Explicitly NOT converted:

- the three enterprise-runner PR jobs in `ci.yml` — they deliberately use `actions/cache/restore` only, keeping cache compression/upload off the paid latency-critical path, an asymmetry `setup-node`'s cache cannot express;
- the Windows job, which deliberately skips the store cache;
- the store-cache step of `ci.yml`'s serial-linux job — the job swaps `corepack enable` for `pnpm/action-setup@v4`, but its `pnpm store path` + `actions/cache@v4` steps stay hand-rolled because the master-push serial-linux run is the save side that populates the exact key and path the enterprise restore-only jobs consume; converting the producer to `setup-node`'s own key format would silently starve their restores.

## Alternatives considered

- **Keep the hand-rolled steps.** They work, but they are five drifting copies of setup boilerplate, and the corepack dependency is a known future break.
- **Convert everything including the enterprise jobs.** Rejected: the restore-only asymmetry is a documented latency decision in `ci.yml`'s comments; erasing it to unify tooling inverts the priority.
- **Convert serial-linux's store cache too.** Rejected during implementation: the proposal counted serial-linux among the symmetric setups, but its cache step is the producer half of the enterprise jobs' restore-only pairing — moving it to `setup-node`'s key format is the enterprise conversion by another route.

## Consequences

- The corepack dependency is gone from every converted workflow; pnpm arrives via the pnpm team's official action, already trusted in-repo (`landlock-run.yml`).
- The cache-key format changed once; one cold run per converted lane repopulates it, after which hit rates match the old steps. The built-in key spans platform, arch, and the lockfile hash but not the Node version, so the node-compat matrix legs share one store entry — safe, because the pnpm store is Node-version-independent.
- `setup-node`'s built-in pnpm cache restores by exact key only, with no `restore-keys` prefix fallback: a `pnpm-lock.yaml` change starts a converted lane from a cold store instead of seeding from the previous entry.
- About 75 net lines of workflow YAML removed; the enterprise-runner PR jobs and the Windows job are byte-identical, and serial-linux keeps producing the key they restore.
