# AGENTS.md — GitHub Actions

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The pull-request `windows` job is the deliberate exception: it runs Windows Node under Wine on hosted Linux and blocks `all checks passed`; `windows-native` runs automatically on `windows-2025` but reports independently — see the [dual-lane Agent Note](../.agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.md).
