# plan-acp-agent

The coding agent as an ACP server with **session modes** composed — the live composition of [the plan-mode RFC](../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).

## What it demonstrates

`session/new` advertises the mode picker (`default` / `plan`) plus the sandbox-mode and approval config options; the editor's `session/set_mode` switches the session, applied at the next turn boundary. The default mode carries the full composition — `bash` under a `workspace-write` sandbox, `read`/`write`/`edit`, `todo_write`, `ask_user_question` — while plan mode narrows it to the read-only allowlist plus the plan-mode guidance section. The bash tools STAY available in plan: plan's `access: read-only` cap clamps the sandbox resolution per call (a `bash/resolve-mode` waterfall listener), so exploration commands run for real while a write is denied by the sandbox itself — and the session's own sandbox-mode knob is never written, so it re-emerges intact on exit. Sandbox escalation (`sandbox_permissions`) is denied inside plan — the widened step belongs in the plan; in the default mode it raises a real `session/request_permission` prompt through the approval seam. Every call outside the allowlist is denied at `tools/pre-execute` with a reason that steers it back to planning, and a blocking decision goes to the user through `ask_user_question`. The model leaves by presenting its plan through `exit_plan_mode`: the plan markdown renders as the tool's call card, the review question arrives as an elicitation form (approve / keep planning, free text welcome), and a keep-planning answer returns the feedback to the model verbatim.

## Run

```sh
pnpm run demo:plan-acp   # needs DEEPSEEK_API_KEY (repo-root .env works)
```

Drive it from Zed or any ACP client; the mode picker appears on the session. Switching back to `default` (or an approved `exit_plan_mode`) restores the full toolset on the next step.

## Tests

`pnpm run test:snapshot` replays three scenarios keyless (the recorded bash re-executes for real under the host's sandbox runner — Seatbelt on macOS, bwrap on Linux CI). `modes-advertise` (authored): the `modes` advertisement and both config options on `session/new`, both `session/set_mode` round-trips with their optimistic `current_mode_update`, and the loud rejection of an unknown mode id, as committed wire bytes. `plan-mode` (recorded, the header pin): the full arc — setMode(plan), the plan-shaped initial header, a real `cat` run inside plan under the clamped read-only sandbox, the plan presented via `exit_plan_mode`, a scripted elicitation approve, the boundary-flushed `mode/set` back and the widened fallback header, then a real edit under the restored toolset. `plan-mode-reject` (recorded): the keep-planning branch, whose corrective `isError` carries the reviewer's free-text feedback verbatim and leaves the session in plan mode. The gate's deny texts and the sandbox-denial marker stay pinned at the unit tier (`packages/mode/mode/tests`, `packages/bash/tool-bash/tests` — a recorded denial's stderr would be the backend's dialect and replay only where it was recorded).
