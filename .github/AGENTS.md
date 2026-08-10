# AGENTS.md — GitHub Actions

Run Windows CI jobs under native `pwsh`. The required pull-request `windows` job and the master `serial-windows` standby both run on real Windows: normally on the hosted enterprise runner, failing over to the self-hosted `[self-hosted, dsh-win-ci, windows]` pool under `DSH_CI_FAILOVER=selfhosted`.
