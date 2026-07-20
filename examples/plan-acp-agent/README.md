# plan-acp-agent

The coding agent as an ACP server with **session modes** composed — the live composition of the [plan-mode Agent Note](../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md).

## What it demonstrates

`session/new` advertises the mode picker (`default` / `plan`) plus the sandbox-mode and approval config options — independent axes on one session. The composition owns its full plan instructions in [`cordis.yml`](cordis.yml): persist in the selected mode, inspect before asking, avoid mutations, resolve discoverable facts from the repository, and produce a decision-complete plan through `exit_plan_mode`. These are the most instrumental behaviors shared by the local Codex and Claude Code plan-mode references without importing their product-specific plan files, phase machinery, or protocol tags.

Plan mode adds only the configured guidance section. Every other tool, including `exit_plan_mode`, has the same schema in `default` and `plan`; the exit tool describes itself as plan-only and rejects if called outside plan mode. Keeping both native schemas and Code Mode's SDK stable avoids tool-catalog churn at the transition. The sandbox retains its own mode (workspace-write here by default), escalation prompts work identically, and a user who wants a hard read-only floor selects read-only separately. A blocking user-owned choice goes through `ask_user_question`. In plan mode, `exit_plan_mode` renders the submitted markdown as a call card and asks for approval or corrective feedback through ACP elicitation.

## Run

```sh
pnpm run demo:plan-acp   # needs DEEPSEEK_API_KEY (repo-root .env works)
```

Drive it from Zed or any ACP client; the mode picker appears beside the sandbox and approval selects. Switching back to `default`, directly or through an approved `exit_plan_mode`, drops only the plan section on the next step. The tool catalog and the independent knobs stay unchanged.

## Tests

`pnpm run test:snapshot` replays the ACP mode and plan-review surfaces keyless, including stable schemas across approval and real filesystem calls under Seatbelt on macOS or bwrap on Linux. `pnpm run test:e2e` adds a self-skipping live-model smoke that verifies the file is unchanged when review appears and changed only after approval. Sandbox denial remains covered at the `dsh-tool-bash` unit tier because recorded backend stderr is platform-specific.
