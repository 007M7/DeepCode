# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs the three required primary Node 24 jobs on standard `ubuntu-latest` and the complete required Windows job on standard `windows-2025`. Static gates publish their exact built tree for the snapshot and artifact job, while coverage remains independent. Top-level gates, coverage, ESLint, publint, and snapshot replay use single-worker bounds on these smaller hosts. Node 22.19, Node 26, and Python SDK compatibility also use standard capacity. The lightweight `all checks passed` aggregate remains a separate scheduling decision because it performs no checkout or repository gate.

The three Linux primary jobs, Node compatibility, Python SDK, and `windows node 24 / complete` remain dependencies of `all checks passed`; no gate is removed or made observational to recover availability. Branch protection continues to require `e2e` and `all checks passed`.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the retained performance measurements and manual suites. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent standard-hosted completeness check.

## Alternatives considered

**Wait for enterprise allocation to recover.** A queue with no assigned runner emits no repository diagnostic and can block every pull request indefinitely, so external recovery is not a correctness path.

**Use only the smallest enterprise pools.** Every named pool crosses the same enterprise allocation boundary; reducing core count does not remove the dependency that caused the queue.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Keep larger-runner worker limits on standard runners.** Concurrent repository gates and their inner worker pools can oversubscribe the smaller memory and CPU allocation, turning an availability repair into contention failures.

## Consequences

Ordinary pull requests can acquire every substantive runner without enterprise-specific configuration. A live exact-head run proves the same commands that branch protection consumes, at the cost of longer elapsed time on smaller hosts.

Manual larger-runner benchmarks can remain queued without blocking pull requests. Restoring larger runners to the required path needs a separate evidence-based decision after exact-head jobs receive nonzero runner IDs and complete reliably; changing a pool definition's status alone is insufficient.
