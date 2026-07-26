# Agent Note: Use pnpm/action-setup for symmetric CI pnpm caching

Status: proposed

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

Five workflows repeat a hand-rolled three-step pnpm setup — `corepack enable`, `pnpm store path --silent >> $GITHUB_OUTPUT`, then `actions/cache@v4` keyed on `pnpm-lock.yaml`: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat, serial-linux, and benchmark jobs of `ci.yml` (~40–60 YAML lines total). The maintained equivalent — `pnpm/action-setup@v4` (reads `packageManager` from package.json) plus `actions/setup-node` with `cache: pnpm` — is already proven in-repo in `landlock-run.yml`, and also insulates against corepack's removal from newer Node distributions.

## Proposal

Convert the symmetric-cache workflows to `pnpm/action-setup@v4` + `setup-node` `cache: pnpm`. Explicitly do NOT convert:

- the three enterprise-runner PR jobs in `ci.yml` — they deliberately use `actions/cache/restore` only, keeping cache compression/upload off the paid latency-critical path, an asymmetry `setup-node`'s cache cannot express;
- the Windows job, which deliberately skips the store cache.

## Alternatives considered

- **Keep the hand-rolled steps.** They work, but they are five drifting copies of setup boilerplate, and the corepack dependency is a known future break.
- **Convert everything including the enterprise jobs.** Rejected: the restore-only asymmetry is a documented latency decision in `ci.yml`'s comments; erasing it to unify tooling inverts the priority.

## Acceptance criteria

- The five symmetric workflows set up pnpm via the actions; one cold run per lane repopulates the new cache-key format, after which cache hit rates match the old steps.
- The enterprise-runner PR jobs and the Windows job are untouched.

## Risks

- Cache-key format changes once (one cold run per lane).
- A third-party action in more workflows; it is already trusted in-repo (`landlock-run.yml`) and is the pnpm team's official action.
