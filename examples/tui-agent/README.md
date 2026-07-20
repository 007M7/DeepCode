# tui-agent

The full-screen interactive coding agent: DeepSeek V4, local bash and filesystem tools, compaction, subagents, workflows and fresh-agent Ralph iteration, `todo_write`, timeout/spill policy, and [`@deepseek-ai/dsh-tui-demo`](../../packages/examples/tui-demo).

## Run it

```sh
pnpm run demo:tui
```

The command needs `DEEPSEEK_API_KEY` in the environment or gitignored repository-root `.env`. Set `RESUME_SESSION_ID` to reopen a persisted conversation under `./.sessions`.

The TUI renders Markdown history, reasoning, tool-owned terminal/diff/generic cards, token totals, and the latest todo list. Enter submits or steers while the agent runs; Ctrl+O expands cards, Ctrl+R toggles reasoning, Escape cancels, and `/help` lists commands. `ask_user_question` opens a keyboard-driven overlay.

Run `pnpm run demo:code-mode tui` for the Code Mode overlay.

## Composition

[`cordis.yml`](cordis.yml) owns the interactive coding composition directly. [`code-mode.cordis.yml`](code-mode.cordis.yml) includes that leaf and replaces the tool presentation mode while adding the code runtime. Non-interactive automation uses the sibling [headless-agent](../headless-agent/README.md) composition.

## Snapshot tests

`tests/snapshots/<scenario>/session.jsonl` supplies recorded user prompts and model chunks; sibling child logs drive subagents and workflows. The keyless suite executes those scripts through the real loop and tools, then compares readable terminal cell/style output. Use `pnpm run test:snapshot:refresh` for presentation-only changes and `pnpm run test:snapshot:record` with a DeepSeek key when a recorded model journey changes. The implemented [TUI snapshot Agent Note](../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md) owns the scenario matrix.
