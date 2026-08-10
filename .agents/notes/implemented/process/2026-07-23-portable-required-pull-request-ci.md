# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs the required primary Node 24 jobs, plus the stable `all checks passed` aggregate, on repo-restricted enterprise 32-core pools. The aggregate performs no checkout or repository gate, but sharing the enterprise pool prevents the required verdict from introducing a separate standard-hosted billing dependency after its substantive jobs have already succeeded. The required Windows job runs native on the enterprise larger runner under normal operation, failing over to the self-hosted pool under `DSH_CI_FAILOVER=selfhosted` ([unified Windows CI note](../../archived/process/2026-08-08-native-windows-pull-request-ci.md)). Standard `ubuntu-latest` jobs retain Node 22.19, Node 26, and Python SDK compatibility, and the serial cross-platform standbys continuously validate the failover targets. Those standard-hosted jobs keep the portable execution boundary observable without duplicating the primary inventory on every pull request.

The two Linux primary jobs, Node compatibility, Python SDK, and `windows node 24 / native complete` remain dependencies of `all checks passed`. The master-only `serial / windows (self-hosted standby)` is deliberately absent from the aggregate, mirroring the Linux standby pattern.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent standard-hosted completeness check, and the manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep the Linux primary jobs and aggregate on standard capacity.** This removes the remaining enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. The current split retains portable compatibility and serial evidence while spending enterprise capacity on the Linux primary critical path.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ordinary pull requests spend enterprise capacity on the Linux critical path while the native Windows job uses the enterprise larger runner on the normal path and the self-hosted pool under failover. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility, required Wine, and diagnostic native Windows jobs remain useful when enterprise allocation is degraded, but they do not make a blocked required Linux job or aggregate green. Recovering Linux availability may require restoring the complete standard-hosted topology; changing a pool definition's status alone is insufficient evidence that it can receive work.
