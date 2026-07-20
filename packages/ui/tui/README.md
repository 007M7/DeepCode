# @deepseek-ai/dsh-tui

The interactive terminal front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires stdin and stdout TTYs; scripts and Loader pipes should compose [`@deepseek-ai/dsh-stdio`](../stdio/README.md) instead.

The implemented [TUI feature Agent Note](../../../.agents/notes/implemented/feature/2026-07-17-dedicated-full-screen-tui-front-door.md) owns the front-door decision; the [terminal-state snapshot Agent Note](../../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md) owns its verification strategy.

This package owns interactive terminal presentation and input only. It injects `agents`, `tools`, and `userInteraction`, then drives an agent created or resumed by app or developer code. Agent lifecycle, persistence, and the model-facing [`ask_user_question`](../tool-ask-user/README.md) tool remain separate composition entries.

The TUI rebuilds resumed history from the active session surface, renders Markdown responses and reasoning, applies each tool's `presentCall` / `presentResult` intent to terminal, diff, or generic cards, keeps the latest `todo/write` plan above the editor, and presents `ctx.userInteraction` questions as keyboard-driven overlays. Surface replacement events rebuild the transcript so compacted history does not reappear.

Before model output, session events, tool presenters, questions, configuration, or diagnostics reach pi-tui's ANSI-aware renderers or the terminal title, the TUI renders C0 and C1 controls other than line feeds as visible `\xNN` text. Those sources cannot add terminal control sequences; the TUI and pi-tui retain ownership of terminal rendering and styling.

While the agent is running, editor submissions call `agent.steer()`; otherwise they call `agent.send()`. Ctrl+C or Escape cancels a running turn. Ctrl+O expands tool cards, Ctrl+R toggles reasoning, Ctrl+L redraws, and Ctrl+D exits while idle. `/help`, `/clear`, `/cancel`, `/reasoning`, `/tools`, `/redraw`, and `/exit` provide the same actions without key chords.

## Config

| Key | Default | Meaning |
|---|---|---|
| `welcome` | `ready.` | Header subtitle |
| `sessionId` | `main` | Exact shared agent/session identity driven by the terminal |
| `showReasoning` | `true` | Render reasoning blocks |
| `maxToolOutputLines` | `12` | Collapsed tool-card output limit |
| `maxQuestionOptions` | `8` | Visible options in a question overlay |
| `questionDialogWidth` | `72` | Question-overlay width in columns |
| `questionDialogMaxHeight` | `20` | Question-overlay maximum rows |
| `showHardwareCursor` | `false` | Show the hardware cursor at pi-tui's IME marker |
| `color` | `true` | Apply the built-in ANSI palette (see [Color](#color)) |
| `title` | `DeepSeek Harness` | Terminal window title |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    sessionId: main-session-123
    showReasoning: true
    maxToolOutputLines: 12
```

Startup fails before mounting when either process stream is not a TTY. The composing app must mount the TUI before its config-created agent so the front door can observe `agent-loop/config-start-failed`; a matching exact-session failure is written before fullscreen mode starts and exits with status 1 instead of leaving a blank terminal. Disposal stops loaders, rejects pending questions, drains terminal input, restores terminal state, unregisters event listeners and the user-interaction provider, and never exits a replacement process during HMR.

## Color

The palette uses the standard 16-color ANSI foregrounds and SGR attributes, which every terminal remaps to its active color scheme, so it stays readable on light and dark backgrounds alike. Body text keeps the terminal's default foreground rather than a fixed shade. Grouped regions (user prompts, tool cards) use a colored left-gutter bar instead of a filled background block, and the question overlay's active row uses reverse video; both are foreground-only, so they never collide with the terminal background. Set `color: false` to strip all styling.

## Model Experience

### Interactive prompt input

#### What the model sees

Each non-empty editor submission becomes one text block, sent with `agent.send()` while the target agent is idle and `agent.steer()` while it is running. Slash commands and keybindings are TUI-only.

#### Token effect

Submitted text is retained under the agent loop's normal session-history and compaction rules. Headers, cards, Markdown rendering, status lines, plans, and help text add no tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Interactive user-question answers

#### What the model sees

When a consumer calls `ctx.userInteraction.ask()`, this provider presents each question in order and returns selected option labels or `custom` text. Abort, cancellation, or UI disposal becomes `Error: ask_user_question was interrupted before the user answered` through `dsh-tool-ask-user`.

#### Token effect

Waiting and terminal overlays add no tokens; the resolved answer or error is model-visible only through the calling tool or plugin's result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **One configured session owns the transcript and editor** — questions from other agents can still use the shared overlay provider, but session rendering and prompt input remain bound to `sessionId`.
- **Tool cards are text terminal presentations** — terminal, diff, and generic cards use tool-owned titles/content, but session content currently has no image block for inline image rendering.
- **Non-TTY operation is intentionally unsupported** — app bundles that need automation must select `dsh-stdio` before mounting this plugin rather than expecting an internal fallback.
