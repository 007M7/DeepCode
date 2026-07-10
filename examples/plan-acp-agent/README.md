# plan-acp-agent

The coding agent as an ACP server with **session modes** composed — the live composition of [the plan-mode RFC](../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).

## What it demonstrates

`session/new` advertises the mode picker (`default` / `plan`); the editor's `session/set_mode` switches the session, applied at the next turn boundary. In plan mode the model sees only the read-only allowlist (`read`, `todo_write`, `exit_plan_mode` here — this tree loads no web tools) plus the plan-mode guidance section, and every call outside the allowlist is denied at `tools/pre-execute` with a reason that steers it back to planning. The model leaves by presenting its plan through `exit_plan_mode`: the plan markdown renders as the tool's call card, the review question arrives as an elicitation form (approve / keep planning, free text welcome), and a keep-planning answer returns the feedback to the model verbatim.

## Run

```sh
pnpm run demo:plan-acp   # needs DEEPSEEK_API_KEY (repo-root .env works)
```

Drive it from Zed or any ACP client; the mode picker appears on the session. Switching back to `default` (or an approved `exit_plan_mode`) restores the full toolset on the next step.

## Tests

`pnpm run test:snapshot` replays three scenarios keyless. `modes-advertise` (authored): the `modes` advertisement on `session/new`, both `session/set_mode` round-trips with their optimistic `current_mode_update`, and the loud rejection of an unknown mode id, as committed wire bytes. `plan-mode` (recorded, the header pin): the full arc — setMode(plan), the plan-shaped initial header, the plan presented via `exit_plan_mode`, a scripted elicitation approve, the boundary-flushed `mode/set` back and the widened fallback header, then a real edit under the restored toolset. `plan-mode-reject` (recorded): the keep-planning branch, whose corrective `isError` carries the reviewer's free-text feedback verbatim and leaves the session in plan mode. The gate's deny texts stay pinned at the unit tier (`packages/mode/mode/tests`).
