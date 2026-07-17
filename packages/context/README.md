# context/ — request-context extensions

Product plugins that add bounded model-visible request context without defining a tool or service. `workspace-context` is included by the default `dsh-agent-spine-demo` bundle and can be disabled through bundle config; `time-context` is opt-in.

| Package | Role | ctx key |
|---|---|---|
| `time-context/` | Current time and elapsed-time system-prompt context | (none) |
| `workspace-context/` | `AGENTS.md`/`CLAUDE.md` workspace context loader | (listens on `agent/session-prefix` + `tools/post-execute`) |

The [`workspace-context` decision record](../../docs/rfc/implemented/feature/2026-06-24-workspace-context.md) explains its per-agent/session isolation and lifecycle split.
