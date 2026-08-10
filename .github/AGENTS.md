# AGENTS.md — GitHub Actions

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The required pull-request `windows` job and the master `serial-windows` standby both run on real Windows; the self-hosted pool uses labels `[self-hosted, dsh-win-ci, windows]`. Under failover (`DSH_CI_FAILOVER=selfhosted`) the `windows` job retargets onto the self-hosted pool.
