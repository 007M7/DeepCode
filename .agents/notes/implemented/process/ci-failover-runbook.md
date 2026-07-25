# Agent Note: CI failover runbook — hosted pools → in-house pool

Status: implemented

English | [中文](ci-failover-runbook.zh.md)

## What this is

The three required Linux jobs in [CI](../../../../.github/workflows/ci.yml) (`node 24 / static`, `node 24 / coverage`, `node 24 / snapshots and artifacts`) resolve their runner pool through the `DSH_CI_FAILOVER` repository variable. Normally the variable is unset and they run on the hosted enterprise 32-core pools. When the hosted pools are degraded (jobs queue indefinitely, the enterprise labels vanish, or GitHub-side capacity fails), a repository admin can retarget all three onto the in-house self-hosted pool without merging anything — merging would itself be blocked by the very checks that are failing.

The in-house pool (`vm-backup`: one 64-core VM, four always-on systemd-managed runner instances, four registered spares) is continuously re-proven by the `serial / linux (self-hosted standby)` lane, which runs the complete unsharded aggregate on every master push. Check its latest run before switching: green standby = verified-yesterday capacity.

## Switch (repo admin, ~1 minute, no merge)

1. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `DSH_CI_FAILOVER`, value `selfhosted`.
2. Re-run the failed/queued required jobs (Re-run failed jobs on affected PRs, or let new pushes pick it up).
3. That is the entire switch. Under failover the workflow also, automatically: halves `DSH_COVERAGE_MAX_WORKERS` to 12 and `DSH_SNAPSHOT_MAX_CONCURRENCY` to 16 (shared-VM contention bounds), and skips the hosted-path pnpm cache restores (the VM's persistent store serves warm installs).

## Capacity during failover

Four always-on instances absorb normal PR traffic. If queues build, bring the four registered spares online on the VM (no token needed — they are already registered):

```bash
for i in 7 8 9 10; do cd /data_local/actions-runner-$i && sudo ./svc.sh install ubuntu && sudo ./svc.sh start; done
```

## Switch back

Delete the `DSH_CI_FAILOVER` variable (or set it to anything other than `selfhosted`). New runs resolve back to the hosted enterprise pools. Stop the spare instances if they were started.

## Trust boundary

The variable is repository-admin-only state: a pull request can neither set it nor read a different value into effect, and the expressions live in the base branch's workflow definition. This failover path therefore adds no PR-editable route to the self-hosted pool. (Runner-side enforcement — an org-level runner group restricting these runners to the master-ref workflow — is tracked separately and composes with this mechanism.)
