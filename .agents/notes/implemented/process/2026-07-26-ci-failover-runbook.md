# Agent Note: CI failover runbook — hosted pools → in-house pool

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

The three required Linux jobs in [CI](../../../../.github/workflows/ci.yml) (`node 24 / static`, `node 24 / coverage`, `node 24 / snapshots and artifacts`) run on the hosted enterprise 32-core pools. When those pools degrade — jobs queue indefinitely, the enterprise labels vanish, or GitHub-side capacity fails — every open pull request becomes unmergeable, and the ordinary recovery of merging a fix is itself deadlocked behind the very required checks that cannot run. An outage therefore needs a switch a repository admin can throw without merging anything.

## Decision

Each of the three required Linux jobs resolves its runner pool through the `DSH_CI_FAILOVER` repository variable. Unset (normal), they run on the hosted enterprise pools. Set to `selfhosted` by a repository admin, all three retarget onto the in-house self-hosted `vm-backup` pool, coverage and snapshot concurrency drop to shared-VM bounds, and the hosted-path pnpm cache restores are skipped. The switch is admin-only repository state, not a merge, so it works while every check is red. The in-house pool's readiness is continuously re-proven by the `serial / linux (self-hosted standby)` lane, which runs the complete unsharded aggregate on every master push.

### What the in-house pool is

`vm-backup`: one 64-core VM, four always-on systemd-managed runner instances, four registered spares. Check the latest `serial / linux (self-hosted standby)` run before switching: a green standby is verified-yesterday capacity.

### Switch (repo admin, ~1 minute, no merge)

1. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `DSH_CI_FAILOVER`, value `selfhosted`.
2. Re-run the failed/queued required jobs (Re-run failed jobs on affected PRs, or let new pushes pick it up).
3. That is the entire switch. Under failover the workflow also, automatically: halves `DSH_COVERAGE_MAX_WORKERS` to 12 and `DSH_SNAPSHOT_MAX_CONCURRENCY` to 16 (shared-VM contention bounds), and skips the hosted-path pnpm cache restores (the VM's persistent store serves warm installs).

### Capacity during failover

Four always-on instances absorb normal PR traffic. If queues build, bring the four registered spares online on the VM (no token needed — they are already registered):

```bash
for i in 7 8 9 10; do cd /data_local/actions-runner-$i && sudo ./svc.sh install ubuntu && sudo ./svc.sh start; done
```

### Switch back

Delete the `DSH_CI_FAILOVER` variable (or set it to anything other than `selfhosted`). New runs resolve back to the hosted enterprise pools. Stop the spare instances if they were started.

### Trust boundary

The variable is repository-admin-only state: a pull request can neither set it nor read a different value into effect, and the expressions live in the base branch's workflow definition. This failover path therefore adds no PR-editable route to the self-hosted pool. Runner-side enforcement — an org-level runner group restricting these runners to the master-ref workflow — is tracked separately and composes with this mechanism.

## Alternatives considered

**Merge a workflow change to switch pools.** Rejected because the outage that motivates the switch is exactly the state in which no PR can merge: the required checks are the ones failing. A repository variable is admin-controlled state that takes effect on re-run without a merge.

**Keep the self-hosted pool always in the required path.** Rejected because it trades hosted-pool availability for the in-house VM's, moving a single point of failure rather than adding a fallback. The variable keeps the hosted pools primary and the self-hosted pool a proven, one-action standby.

## Consequences

Recovering from a hosted-pool outage is a single admin variable plus a re-run, with no merge on the critical path. The cost is a second runner topology to keep working: the standby lane exercises it on every master push so the failover target never goes stale, and the concurrency and cache-restore branches in `ci.yml` carry a `selfhosted` leg that must stay in step with the hosted leg.
