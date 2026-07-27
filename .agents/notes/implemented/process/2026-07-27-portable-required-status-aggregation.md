# Agent Note: Portable required-status aggregation

Status: implemented

English | [中文](2026-07-27-portable-required-status-aggregation.zh.md)

## Problem

Branch protection consumes one stable `all checks passed` job instead of tracking the changing names of matrix legs and execution lanes. This job performs no repository work: after its blocking dependencies finish, it only reduces their results into the required verdict.

Assigning that bookkeeping job to a custom runner pool adds an external allocation dependency without using the pool's additional CPU or memory. A provisioning failure can therefore leave the final required status queued even after every substantive check has produced its evidence.

## Decision

The `all-checks-passed` job in [CI](../../../../.github/workflows/ci.yml) runs on standard GitHub-hosted `ubuntu-latest`. It keeps every blocking job in `needs`, retains its load-bearing `if: always()` condition, fails when any dependency is failed, cancelled, or skipped, and succeeds only when every dependency succeeds. It performs no checkout, toolchain setup, dependency installation, or repository gate.

The aggregate depends only on production standard-hosted capacity; it does not use organization-defined, enterprise-defined, or self-hosted labels. Substantive jobs choose their own runner topology independently. Moving this verdict does not change their commands, weaken their evidence, or make an unresolved dependency pass: the aggregate waits for unfinished dependencies and fails on non-success terminal results.

This decision supersedes only the aggregate-placement clause in the [portable pull-request CI recovery boundary](2026-07-23-portable-required-pull-request-ci.md), which continues to own the substantive jobs' recovery topology. The final bookkeeping status remains separately owned so runner-topology changes and branch-protection aggregation can evolve independently.

## Alternatives considered

**Run the aggregate beside substantive jobs on a custom enterprise pool.** This avoids one short standard-hosted allocation, but gives the bookkeeping job a provisioning failure mode without using the larger machine's capacity.

**Use a standby self-hosted runner.** This replaces one external readiness dependency with another and makes a required verdict depend on a separately operated machine. Managed standard-hosted capacity is the production path for this bookkeeping work.

**Require every substantive job directly in branch protection.** This removes the aggregate allocation, but couples repository settings to matrix and lane names that change as the CI topology evolves.

**Treat missing or non-success dependencies as success.** This would produce a green status by discarding required evidence rather than by completing it.

## Consequences

Each pull request allocates one short standard-hosted job after its substantive dependencies settle. Because the job performs no checkout or setup, it adds little active runtime, but its scheduling and billing remain separate from custom pools.

A custom-pool outage can still keep a substantive dependency queued, and the aggregate correctly waits in that case. Once the dependencies reach terminal results, the final required verdict no longer needs custom-pool or self-hosted allocation. Future changes can move substantive jobs between standard and larger runners without reintroducing that dependency into the branch-protection status.
