# context/ — request-context extensions

English | [中文](README.zh.md)

Product plugins that add model-visible request context without defining a tool. `workspace-context` is included by the default `dsh-agent-spine-demo` bundle and can be disabled through bundle config; `time-context` is opt-in, while the standard TUI bundle composes `session-reference` explicitly.

| Package | Role | ctx key |
|---|---|---|
| `session-reference/` | Bounded current-surface snapshots of other sessions | `ctx.sessionReferences` |
| `time-context/` | Durable per-step current time and elapsed-time context | (none) |
| `workspace-context/` | `AGENTS.md`/`CLAUDE.md` workspace context loader | (listens on `agent/step` + `tools/post-execute`) |

The [`workspace-context` decision record](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) explains its per-agent/session isolation and lifecycle split.
