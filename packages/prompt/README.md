# prompt/ — prompt and request-context extensions

Product packages that contribute model-facing prompt or request-context behavior without being core agent/session/tool primitives. These packages usually consume existing seams such as `agent/request` or `system-prompt/assemble`; they do not own the loop and do not provide LLM adapters, execution backends, or UI front doors.

| Package | Role | ctx key |
|---|---|---|
| `project-instructions/` | `AGENTS.md`/`CLAUDE.md` workspace context loader | (listens on `agent/request`) |

`project-instructions` lives here because it is semantically a prompt/context extension: it adds workspace guidance to the model request. It deliberately uses the per-agent `agent/request` seam instead of a global `ctx.systemPrompt.section()` so multiple live sessions with different `cwd` values do not leak instruction files into one another.
