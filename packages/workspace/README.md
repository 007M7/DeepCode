# workspace/ — workspace entity family

English | [中文](README.zh.md)

This family owns persistent workspaces: user directories with titles and ordered session membership.

| Package | Role | ctx key |
|---|---|---|
| [`workspace/`](workspace/README.md) | Registers workspaces and accounts for their sessions | `ctx.workspace` |

Workspace deletion removes the registry record, not user files or session logs. See the [workspace lifecycle decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md) and [storage design](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).
