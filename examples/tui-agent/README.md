# tui-agent

The full-screen terminal counterpart to the [`coding-agent`](../coding-agent/README.md) readline REPL and [`acp-agent`](../acp-agent/README.md) server. It reuses the coding agent's backends and tool composition, then fixes the shared terminal app to the `dsh-tui` front door.

## Run it

```sh
pnpm run demo:tui
```

The command needs `DEEPSEEK_API_KEY` in the environment or the gitignored repository-root `.env`. Set `RESUME_SESSION_ID` to reopen a persisted conversation under `./.sessions`.

The TUI renders Markdown history, reasoning, tool-owned terminal/diff/generic cards, token totals, and the latest todo list. Enter submits or steers while the agent is running; Ctrl+O expands cards, Ctrl+R toggles reasoning, Escape cancels, and `/help` lists commands. `ask_user_question` opens a keyboard-driven overlay.

Run `pnpm run demo:code-mode tui` for the sibling Code Mode overlay.

## Composition

[`cordis.yml`](cordis.yml) includes the readline coding-agent leaf so the LLM, bash, filesystem, compaction, subagent, workflow, todo, timeout, and spill choices have one owner. Its asserted patch replaces only the terminal app config and forces `ui.mode: tui`; [`code-mode.cordis.yml`](code-mode.cordis.yml) applies the same front-door patch to the coding agent's Code Mode overlay.
