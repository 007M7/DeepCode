# plan-acp-agent

The coding agent as an ACP server with **session modes** composed — the live composition of [the plan-mode RFC](../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).

## What it demonstrates

`session/new` advertises the mode picker (`default` / `plan`) plus the sandbox-mode and approval config options; the editor's `session/set_mode` switches the session, applied at the next turn boundary. Plan mode adds the plan guidance section and the `exit_plan_mode` tool, and enforces its read-only stance where an enforcer exists: plan's `access: read-only` cap clamps every bash call's sandbox resolution (a `bash/resolve-mode` waterfall listener), so exploration commands run for real while a write is denied by the sandbox itself — and the session's own sandbox-mode knob is never written, so it re-emerges intact on exit. Sandbox escalation (`sandbox_permissions`) is denied inside plan — the widened step belongs in the plan; in the default mode it raises a real `session/request_permission` prompt through the approval seam. There is deliberately no per-mode tool list: the `write`/`edit` tools stay present in plan and the section's guidance is what defers changes to after the review (the effects-based generalization is the RFC's deferred item). A blocking decision goes to the user through `ask_user_question`. The model leaves by presenting its plan through `exit_plan_mode`: the plan markdown renders as the tool's call card, the review question arrives as an elicitation form (approve / keep planning, free text welcome), and a keep-planning answer returns the feedback to the model verbatim.

## Run

```sh
pnpm run demo:plan-acp   # needs DEEPSEEK_API_KEY (repo-root .env works)
```

Drive it from Zed or any ACP client; the mode picker appears on the session. Switching back to `default` (or an approved `exit_plan_mode`) lifts the plan constraints — the sandbox clamp included — on the next step.

## Tests

`pnpm run test:snapshot` replays three scenarios keyless (the recorded bash re-executes for real under the host's sandbox runner — Seatbelt on macOS, bwrap on Linux CI). `modes-advertise` (authored): the `modes` advertisement and both config options on `session/new`, both `session/set_mode` round-trips with their optimistic `current_mode_update`, and the loud rejection of an unknown mode id, as committed wire bytes. `plan-mode` (recorded, the header pin): the full arc — setMode(plan), the plan-shaped initial header (full toolset + exit tool + section), a real `cat` run inside plan under the clamped read-only sandbox, the plan presented via `exit_plan_mode`, a scripted elicitation approve, the boundary-flushed `mode/set` back with its pure-removal `request/header-delta`, then a real edit mid-turn. `plan-mode-reject` (recorded): the keep-planning branch, whose corrective `isError` carries the reviewer's free-text feedback verbatim and leaves the session in plan mode. The cap-guard deny texts and the sandbox-denial marker stay pinned at the unit tier (`packages/mode/mode/tests`, `packages/bash/tool-bash/tests` — a recorded denial's stderr would be the backend's dialect and replay only where it was recorded).
