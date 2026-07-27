# Agent Note: Provision CI pnpm via pnpm/action-setup

Status: implemented

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

Every workflow hand-provisioned pnpm with `corepack enable`, and five of them further repeated a hand-rolled cache setup — `pnpm store path --silent >> $GITHUB_OUTPUT`, then `actions/cache@v4` keyed on `pnpm-lock.yaml`: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat, serial-linux, and benchmark jobs of `ci.yml` (~40–60 YAML lines of drifting copies). The maintained equivalent — `pnpm/action-setup@v4` (reads `packageManager` from package.json) plus `actions/setup-node` with `cache: pnpm` — was already proven in-repo in `landlock-run.yml`, and corepack's removal from newer Node distributions made every `corepack enable` a known future break.

## Decision

`pnpm/action-setup@v4` is the only pnpm provisioning mechanism in CI: no workflow runs `corepack enable`. Caching remains per-job policy on top of it, in three deliberate shapes:

- **Symmetric cache** (restore and save): `actions/setup-node` with `cache: pnpm` — `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat and two benchmark jobs of `ci.yml`. The larger-runner benchmark keeps its store cache Linux-only through a conditional `cache:` input; the consolidated benchmark caches on both platforms.
- **Restore-only / producer pairing** (hand-rolled `actions/cache` steps, unchanged): the three enterprise-runner PR jobs restore without saving, keeping cache compression/upload off the paid latency-critical path — an asymmetry `setup-node`'s cache cannot express — and the master-push serial-linux job keeps its `pnpm store path` + `actions/cache@v4` save side, because it populates the exact key and path those restore-only jobs consume; converting the producer to `setup-node`'s key format would silently starve their restores.
- **Cache-less** (no store cache at all): the required Windows job and serial-windows (many-file store extraction is slower than a clean install there), serial-macos, sandbox.yml, and the coverage/consumers enterprise jobs that already restore via the shared enterprise key.

## Alternatives considered

- **Keep the hand-rolled steps.** They worked, but they were drifting copies of setup boilerplate, and the corepack dependency was a known future break.
- **Convert the enterprise jobs' caching to `cache: pnpm`.** Rejected: the restore-only asymmetry is a documented latency decision in `ci.yml`'s comments; erasing it to unify tooling inverts the priority.
- **Convert serial-linux's store cache.** Rejected during implementation: the original proposal counted serial-linux among the symmetric setups, but its cache step is the producer half of the enterprise jobs' restore-only pairing — moving it to `setup-node`'s key format is the enterprise conversion by another route.
- **Stop at the cache-bearing workflows and leave the other `corepack enable` sites.** Rejected on review follow-up: provisioning and caching are separable concerns, and leaving corepack in the cache-less jobs kept the future break and two provisioning idioms for no benefit.
- **A composite action wrapping action-setup + setup-node.** Rejected for now: the remaining per-job variation (node-version matrices, per-platform conditional caching, the restore-only pairing) is deliberate policy, not boilerplate — a wrapper would grow mirroring inputs or flatten a real asymmetry, and the two-line pair is already near the floor.

## Consequences

- The corepack dependency is gone from CI entirely; pnpm arrives via the pnpm team's official action everywhere, and the version pin stays single-sourced in `package.json`'s `packageManager` field.
- The cache-key format changed once for converted lanes; one cold run repopulated it, after which hit rates match the old steps. The built-in key spans platform, arch, and the lockfile hash but not the Node version, so the node-compat matrix legs share one store entry — safe, because the pnpm store is Node-version-independent.
- `setup-node`'s built-in pnpm cache restores by exact key only, with no `restore-keys` prefix fallback: a `pnpm-lock.yaml` change starts a converted lane from a cold store instead of seeding from the previous entry.
- About 75 net lines of workflow YAML removed. The enterprise-runner PR jobs' and Windows jobs' cache behavior is unchanged (only their provisioning line moved to the action), and serial-linux keeps producing the key the restore-only jobs consume.
