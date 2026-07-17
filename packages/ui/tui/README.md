# @deepseek-ai/dsh-tui

The interactive terminal front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires stdin and stdout TTYs; scripts and Loader pipes should compose [`@deepseek-ai/dsh-stdio`](../stdio/README.md) instead.

This package owns interactive terminal presentation and input only. It injects `agents`, `tools`, and `userInteraction`, then drives an agent created or resumed by app or developer code. Agent lifecycle, persistence, and the model-facing [`ask_user_question`](../tool-ask-user/README.md) tool remain separate composition entries.

The TUI rebuilds resumed history from the active session surface, renders Markdown responses and reasoning, applies each tool's `presentCall` / `presentResult` intent to terminal, diff, or generic cards, keeps the latest `todo/write` plan above the editor, and presents `ctx.userInteraction` questions as keyboard-driven overlays. Surface replacement events rebuild the transcript so compacted history does not reappear.

While the agent is running, editor submissions call `agent.steer()`; otherwise they call `agent.send()`. Ctrl+C or Escape cancels a running turn. Ctrl+O expands tool cards, Ctrl+R toggles reasoning, Ctrl+L redraws, and Ctrl+D exits while idle. `/help`, `/clear`, `/cancel`, `/reasoning`, `/tools`, `/redraw`, and `/exit` provide the same actions without key chords.

## Config

| Key | Default | Meaning |
|---|---|---|
| `welcome` | `ready.` | Header subtitle |
| `agent` | `main` | Agent id driven by the terminal |
| `showReasoning` | `true` | Render reasoning blocks |
| `maxToolOutputLines` | `12` | Collapsed tool-card output limit |
| `maxQuestionOptions` | `8` | Visible options in a question overlay |
| `questionDialogWidth` | `72` | Question-overlay width in columns |
| `questionDialogMaxHeight` | `20` | Question-overlay maximum rows |
| `showHardwareCursor` | `false` | Show the hardware cursor at pi-tui's IME marker |
| `color` | `true` | Apply the built-in ANSI palette |
| `title` | `DeepSeek Harness` | Terminal window title |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    agent: main
    showReasoning: true
    maxToolOutputLines: 12
```

Startup fails before mounting when either process stream is not a TTY. Disposal stops loaders, rejects pending questions, drains terminal input, restores terminal state, unregisters event listeners and the user-interaction provider, and never exits a replacement process during HMR.

## Model Experience

### Interactive prompt input

**What the model sees**: Each non-empty editor submission becomes one text block, sent with `agent.send()` while the target agent is idle and `agent.steer()` while it is running. Slash commands and keybindings are TUI-only.

**Token effect**: Submitted text is retained under the agent loop's normal session-history and compaction rules. Headers, cards, Markdown rendering, status lines, plans, and help text add no tokens.

### Interactive user-question answers

**What the model sees**: When a consumer calls `ctx.userInteraction.ask()`, this provider presents each question in order and returns selected option labels or `custom` text. Abort, cancellation, or UI disposal becomes `Error: ask_user_question was interrupted before the user answered` through `dsh-tool-ask-user`.

**Token effect**: Waiting and terminal overlays add no tokens; the resolved answer or error is model-visible only through the calling tool or plugin's result.

## Known Limitations and Deferred Work

- **One configured agent owns the transcript and editor** — questions from other agents can still use the shared overlay provider, but session rendering and prompt input remain bound to `agent`.
- **Tool cards are text terminal presentations** — terminal, diff, and generic cards use tool-owned titles/content, but session content currently has no image block for inline image rendering.
- **Non-TTY operation is intentionally unsupported** — app bundles that need automation must select `dsh-stdio` before mounting this plugin rather than expecting an internal fallback.
