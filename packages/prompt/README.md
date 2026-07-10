# prompt/ — prompt and request-context extensions

Product packages that contribute model-facing prompt or request-context behavior without being core agent/session/tool primitives. These packages usually consume existing seams such as `agent/session-prefix`, `agent/request`, `tools/post-execute`, or `system-prompt/assemble`; they do not own the loop and do not provide LLM adapters, execution backends, or UI front doors.

| Package | Role | ctx key |
|---|---|---|
| `workspace-context/` | `AGENTS.md`/`CLAUDE.md` workspace context loader | (listens on `agent/session-prefix` + `tools/post-execute`) |

`workspace-context` lives here because it adds workspace guidance to the model request without owning a core service. Its [decision record](../../docs/rfc/implemented/feature/2026-06-24-workspace-context.md) explains the per-agent/session isolation and lifecycle split.
