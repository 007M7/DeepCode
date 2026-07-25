# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs the required primary Node 24 and Windows jobs on repo-restricted enterprise 32-core pools. Standard `ubuntu-latest` jobs retain Node 22.19, Node 26, and Python SDK compatibility, and `master` runs complete serial Linux, macOS, and Windows references. Those standard-hosted jobs keep the portable execution boundary observable without duplicating the primary inventory on every pull request.

The two Linux primary jobs, Node compatibility, Python SDK, and `windows node 24 / complete` remain dependencies of `all checks passed`; branch protection continues to require `e2e` and `all checks passed`. There is no automatic fallback when an enterprise label cannot allocate: the standard jobs continue to report their own contracts, but they cannot manufacture the missing required result.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent standard-hosted completeness check, and the manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep every required job on standard capacity.** This removes the enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. The current split retains portable compatibility and serial evidence while spending enterprise capacity on the primary critical path.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ordinary pull requests receive lower active runtime at the cost of depending on enterprise configuration and paid rounded minutes. A live exact-head run proves the same commands that branch protection consumes; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility and serial jobs remain useful when enterprise allocation is degraded, but they do not make a blocked required aggregate green. Recovering availability may require temporarily restoring the complete standard-hosted topology; changing a pool definition's status alone is insufficient evidence that it can receive work.
