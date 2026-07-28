# Agent Note: Dependabot version updates with a 30-day cooldown

Status: implemented

English | [中文](2026-07-27-dependabot-version-updates.zh.md)

## Problem

Maintained registry and GitHub Actions dependencies need a regular update path. Adopting every release immediately increases exposure to compromised releases and early regressions, while leaving updates entirely manual lets dependency drift accumulate. Vendored Cordis sources and independently locked workspaces also cannot be treated as one undifferentiated package tree.

## Decision

The default branch carries [`.github/dependabot.yml`](../../../../.github/dependabot.yml) with weekly version-update checks for the root pnpm workspace, the independently locked `native/landlock-run` pnpm workspace, the `python/sdk` uv project, and GitHub Actions. Every entry sets `cooldown.default-days` to `30`, so a version release becomes eligible only after it is at least 30 days old and is proposed on the next weekly check.

The root pnpm version-update scan excludes `vendor/**`, whose source and manifests move only through the [vendoring procedure](../../../../vendor/README.md), and `native/landlock-run/**`, which its dedicated entry owns. GitHub applies `exclude-paths` only to version updates; a security pull request that touches a vendored manifest is replaced through the vendoring procedure instead of being merged as generated. Dependabot pull requests receive the repository's `cleanup` kind and `area/infra` area labels, run the normal pull-request checks, and remain subject to maintainer review; this automation does not merge them.

Repository settings enable dependency vulnerability alerts and Dependabot security updates. GitHub does not apply version-update cooldowns to those security updates, so security fixes remain eligible immediately. A generated pnpm security pull request can still fail the repository's lockfile release-age verification when dependency resolution selects unrelated fresh transitive versions; that pull request waits or is narrowed instead of weakening the policy. The repository's coordinated fresh-release exceptions are not copied into Dependabot's cooldown exclusions: automated version updates use the uniform 30-day wait, while an explicitly reviewed manual update can still follow its owning release procedure.

The pnpm entries keep both workspaces on their pinned pnpm 11 instead of introducing an automation-only downgrade. The current Dependabot updater installs the version requested by `packageManager` and reads both workspaces' lockfile format `9.0`; the provider-run update job remains the integration check.

## Alternatives considered

- **Immediate version updates.** Rejected because they remove the requested release-age quarantine and make the project an early consumer of every upstream release.
- **Automatic merging after CI.** Rejected because dependency changes can alter runtime, build, and release behavior; the normal review decision remains part of accepting an update.
- **One recursive npm scan.** Rejected because it could admit vendored manifests or conflate the root and native lockfiles. Explicit exclusions and a dedicated native entry preserve their ownership boundaries.
- **Renovate or a scheduled agent.** Both can propose aged updates, but Dependabot is the requested service and the repository's CI already recognizes its pull requests as an untrusted dependency source.
- **Cooldown exemptions for coordinated fresh releases.** Rejected for the automated path because those releases require an explicit synchronization or model-catalog decision rather than a generic update proposal.

## Consequences

- Routine dependency updates arrive in small reviewable pull requests after the quarantine instead of requiring periodic manual discovery.
- A release normally appears between 30 and 36 days after publication because eligibility is evaluated weekly.
- Dependabot does not delay security proposals; repository checks can still block unrelated fresh transitives, and review preserves the vendoring boundary.
- Maintainers still decide whether to merge each update and diagnose any provider limitation reported by the pnpm 11 update job.
