# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The interactive terminal front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires stdin and stdout TTYs; scripts and Loader pipes should use the one-shot [`@deepseek-ai/dsh-cli-demo`](../../examples/cli-demo/README.md) app instead.

The implemented [TUI feature Agent Note](../../../.agents/notes/implemented/feature/2026-07-17-dedicated-full-screen-tui-front-door.md) owns the front-door decision; the [file-reference autocomplete Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-tui-file-reference-autocomplete.md) owns path-only `@file` behavior; the [terminal-state snapshot Agent Note](../../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md) owns its verification strategy.

Interactive terminals on macOS, Linux, and Windows are supported. Windows uses pi-tui's native console VT-input handling, and the [Windows support Agent Note](../../../.agents/notes/implemented/feature/2026-07-20-windows-tui-support.md) owns the platform decision and ConPTY process verification.

This package owns interactive terminal presentation and input only. It injects `agents`, [`commands`](../commands/README.md), `llm`, `systemPrompt`, `tokenMeter`, `tools`, and `userInteraction`, optionally reads a `skills` service (present only when one is mounted), then drives an agent created or resumed by app or developer code. Agent lifecycle, persistence, and the model-facing [`ask_user_question`](../tool-ask-user/README.md) tool remain separate composition entries.

After terminal startup succeeds, the package provides the terminal-local `ctx.tui` extension service. A plugin that injects it can call `openOverlay()` with a component factory and constrained layout options; the host exposes the viewport, semantic theme, display-text escaping, redraw, close, and a lifetime signal, but not the pi-tui tree, terminal, focus controller, or overlay handle. Plugin overlays, the model selector, and user questions share one FIFO modal queue. Each request is an effect of the calling plugin fiber, so unload removes queued work or closes visible work before cleanup settles; terminal shutdown unloads dependents before stopping pi-tui. Overlay state is not logged or replayed. Component code is trusted and may render ANSI styling, but must pass untrusted text through `host.display()`. The [interactive-extension Agent Note](../../../.agents/notes/implemented/architecture/2026-07-22-tui-interactive-extension-service.md) owns the boundary and rejected alternatives.

The TUI rebuilds resumed history from the active session surface, renders Markdown responses and reasoning, applies each tool's `presentCall` / `presentResult` intent to terminal, diff, or generic cards, keeps the latest `todo/write` plan above the editor, and presents `ctx.userInteraction` questions in a wide bottom-left keyboard panel with progress, numbered options, and aligned descriptions. The latest logged session title becomes the header subtitle, with `welcome` before a title exists, and the terminal window title becomes `<session title> — <configured title>`. A durable `llm/retry` event retracts the failed step's live chunks and renders the scheduled retry count, delay, and failure in the transcript; success, exhaustion, and cancellation then settle through ordinary session events. The footer totals each logged model step's usage once, including failed attempts, while treating committed-message usage as a fallback for logs without a usage chunk. Its idle view compares token-meter pressure with `ctx.llm.resolveModelContext()` for the current route, displays `context unknown` when the adapter has no capacity metadata, and also shows tool-card mode and the current model with reasoning state; while the agent runs, an elapsed working indicator and `esc interrupt` replace that summary. Surface replacement events rebuild the transcript so compacted history does not reappear.

An embedding may provide `TuiRuntime.formatCwd` when its logical workspace label differs from the session's host directory. The override changes only the footer label; tools continue to use the session `cwd`.

Before model output, session events, tool presenters, questions, configuration, or diagnostics reach pi-tui's ANSI-aware renderers or the terminal title, the TUI renders C0 and C1 controls other than line feeds as visible `\xNN` text. Those sources cannot add terminal control sequences; the TUI and pi-tui retain ownership of terminal rendering and styling.

Typing `@` at a token boundary searches files and directories under the session working directory. A bare fuzzy query uses a reusable bounded workspace index; a query containing `/` lists that directory directly, and selecting a folder keeps completion open for descent. Whitespace-bearing paths are inserted as `@"path with spaces"`. Selecting a file inserts only its path and a trailing space: the TUI does not read it, attach hidden context, or replace it with a reference object. When a model-facing `read` tool is registered, the TUI adds one fixed system-prompt instruction telling the model to read an explicit path when its contents are needed.

When optional `ctx.sessionReferences` is mounted, the same `@` menu also offers metadata-only session candidates, inserts `@[label](dsh-session:<payload>)`, and prepares the selected snapshots before dispatch. Session references remain structured because the model has no filesystem-like tool for retrieving session snapshots later. Preparation disables duplicate submission and restores the editor input on failure. The TUI chooses `agent.steer()` or `agent.followup()` from the status after that asynchronous preparation, so idle follow-ups still dispatch `agent/prompt-submit` while in-turn steering joins at a checkpoint without that hook.

While the agent is running, ordinary editor submissions call `agent.steer()`; otherwise they call `agent.followup()`. A slash at the start of the submitted line enters `ctx.commands` instead: known commands execute directly, unknown commands produce a warning, and neither path automatically reaches the model. A command producer may explicitly schedule agent work; [`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-surfaces) uses that contract for `/plan [message]`. The TUI registers `/help`, `/model`, `/clear`, `/reasoning`, `/tools`, `/redraw`, `/reload`, `/resume`, `/status`, and `/exit` as agent-scoped definitions; every other effective command joins autocomplete and `/help` dynamically, as do `/skill:` completions. A status line above the editor reports the turn phase the TUI derives from session events — waiting for the first token, thinking, responding, or executing tools — with the elapsed time in that phase and the running step total, refreshed each second, and ends with the `Enter sends steering, Esc cancels` hint; while steering messages wait to reach the model it inserts a `N queued ·` badge before the hint that clears as each drains. Ctrl+C or Escape cancels a running turn. Tool cards collapse long bodies into a configurable head/tail preview; Ctrl+O toggles every card between its preview and full output. Ctrl+R toggles reasoning, Ctrl+L redraws, and Ctrl+D exits while idle.

`/model` opens the advisory `ctx.llm` catalog as a keyboard selector: Up/Down moves, Enter selects, and Escape closes it. `/model <model>` still selects an unambiguous model id directly, while `/model <provider>/<model>` selects an exact target. The configured target or latest logged request header initializes the selector, and an unlisted current model remains visible because catalogs are advisory. Selection is local to this TUI session. Prompt assembly snapshots the target for one step, replaces `{{provider}}` and `{{model}}`, and applies the same pair through `agent/request`; a switch during assembly therefore starts with a later step. The request header durably records targets that reach the model, while an unused selection remains process-local.

`/reload` (EXPERIMENTAL, dev-only) re-reads every file-backed loader config tree and applies the diff to the running app — the HMR watcher's config path, invoked manually; it needs the cordis Loader in the context and degrades to a warning without one, runs only while the agent is idle, and refuses re-entry while a reload is in flight. Module-source hot reload remains watcher-owned. When a `skills` service is mounted, `/skill:<name> [instructions]` loads that skill's instructions into the conversation as a user turn; autocomplete lists the model-invocable skills, and any skill (including a model-disabled one) is loadable by its exact name.

The footer sums the session's reported usage as `↑<uncached input> ↓<output>`, followed by `cache <rate>%` once any input has been billed — the share of billed prompt tokens (uncached input plus cache reads and writes) served from the provider cache, rounded to a percent. It also compares token-meter pressure with `ctx.llm.resolveModelContext()` for the current route (omitting the context share when the adapter has no capacity metadata) and shows the current model and tool-card mode; the right side clips first when the footer is narrow.

`/status` adds a point-in-time diagnostics card to the transcript and remains available while the agent runs. It reports the session id, title, working directory, selected provider/model, reasoning-block visibility, agent state, event/turn/step/tool-call counts, exact input/output/cache token buckets, KV-cache hit rate, token-meter context use and capacity, creation time, and latest event time. Missing titles, models, cache input, or context capacity are labeled instead of inferred. The card is terminal-only and does not duplicate the compact footer.

`/resume` opens a full-viewport keyboard selector over the current workspace instead of a centered dialog. Its focused search field starts immediately after the search glyph and emits pi-tui's cursor marker, so terminal IME composition remains anchored inside the field. Candidates are sorted by last logged activity and searchable by log-backed title or session id; each row reports current/live/persisted state, last turn outcome, recent provider/model, and durable goal phase when present. Up/Down and Page Up/Page Down navigate, Enter resumes, Escape clears a non-empty search before a second Escape cancels, and Ctrl+C cancels directly. The current session, a session already live in this runtime, an unreadable log, a mismatched cwd, or a session whose logged provider has no current adapter remains visible but disabled. Selection repeats those checks and requires the current agent to be idle before flushing the current session. The TUI then stops the terminal UI and calls the optional host-owned `TuiRuntime.handoffResume`; where `process.execve` is available, the shipped `dsh` host disposes the app and replaces its process. Resume restores the same `SessionId`, transcript, title, todos, and durable goal; goal activation remains disarmed and the TUI asks for human confirmation or `/goal resume`.

`resumeCommand` remains the deployment-owned fallback: exiting prints it only after the current session is durable, and a host without in-place handoff shows the selected session's command. `{session}` expands to the session id. TUI code never executes the template or arbitrary shell text.

## Config

| Key | Default | Meaning |
|---|---|---|
| `welcome` | — | Banner subtitle line until the session has a logged title; unset, the banner sweeps in with no subtitle |
| `sessionId` | `main` | Exact shared agent/session identity driven by the terminal |
| `showReasoning` | `true` | Render reasoning blocks |
| `maxToolOutputLines` | `6` | Output lines retained across a collapsed tool card's head/tail preview |
| `maxQuestionOptions` | `8` | Visible options in a question panel |
| `maxModelOptions` | `8` | Visible models in the model selector |
| `maxResumeOptions` | `8` | Visible sessions in the resume selector |
| `questionDialogWidth` | `200` | Question-panel width in columns, clamped to the terminal |
| `questionDialogMaxHeight` | `20` | Question-panel maximum rows |
| `modelDialogWidth` | `72` | Model-selector width in columns |
| `modelDialogMaxHeight` | `20` | Model-selector maximum rows |
| `fileSearchMaxResults` | `20` | Maximum file and directory candidates shown for one `@` query |
| `fileSearchMaxEntries` | `10000` | Maximum paths retained in the bounded workspace index used by bare fuzzy queries |
| `fileSearchExcludedDirectories` | `['.git', 'node_modules']` | Directory basenames omitted from traversal and direct completion |
| `showHardwareCursor` | `false` | Show the hardware cursor at pi-tui's IME marker |
| `color` | `true` | Apply the built-in ANSI palette (see [Color](#color)) |
| `title` | `DeepSeek Harness` | Product suffix for the terminal window title. |
| `resumeCommand` | — | Shell command template for the exit hint and hosts without in-place handoff, with `{session}` expanded to the session id |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    sessionId: main-session-123
    showReasoning: true
    maxToolOutputLines: 6
    fileSearchExcludedDirectories: ['.git', 'node_modules', 'dist']
```

Startup fails before mounting when either process stream is not a TTY. The composing app must mount the TUI before its config-created agent so the front door can observe `agent-loop/config-start-failed`; a matching exact-session failure is written before fullscreen mode starts and exits with status 1 instead of leaving a blank terminal. Disposal stops extension admission, unloads the `ctx.tui` provider and its dependent plugins, aborts running commands, removes the TUI definitions, stops loaders, rejects pending questions, drains terminal input, restores terminal state, unregisters event listeners and the user-interaction provider, and never exits a replacement process during HMR.

## Color

The palette uses the standard 16-color ANSI foregrounds and SGR attributes, which every terminal remaps to its active color scheme, so it stays readable on light and dark backgrounds alike. Body text keeps the terminal's default foreground rather than a fixed shade. Grouped regions (user prompts, tool cards) use a colored left-gutter bar instead of a filled background block; the question panel emphasizes its active row with bold accent text, while selectors use reverse video. These treatments are foreground-only, so they never collide with the terminal background. Set `color: false` to strip all styling.

## Model Experience

### Interactive prompt input

#### What the model sees

Each non-empty ordinary editor submission becomes one text block, sent with `agent.followup()` while the target agent is idle and `agent.steer()` while it is running. A session mention becomes readable `@label` text plus the durable untrusted context defined by [`dsh-session-reference`](../../context/session-reference/README.md); its full JSON is hidden behind a compact reference card. Slash commands and keybindings are TUI-only; command results remain terminal notices. A command producer may schedule a separate agent input, such as the optional message accepted by `/plan [message]`.

#### Token effect

Submitted text is retained under the agent loop's normal session-history and compaction rules. Headers, the logged title, cards, Markdown rendering, status lines, plans, and help text add no tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### File-reference autocomplete

#### What the model sees

A selected file remains ordinary user text such as `@src/index.ts` or `@"docs/design notes.md"`; autocomplete adds no content block, durable context, or special reference payload. When `read` is registered, every request from this TUI agent also contains the following fixed system-prompt section. The model decides whether the task requires the file contents and calls `read` through the normal tool loop when it does; a path alone is not evidence that the file was inspected.

##### Exact system-prompt text

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token effect

Autocomplete itself adds no tokens. The selected path contributes only its ordinary user-text tokens; the fixed instruction contributes system-prompt tokens whenever `read` is available. File contents consume context only after a model-selected `read` call returns them.

#### KV Cache effect

The fixed instruction is part of the stable system-prompt prefix and is reusable across turns. Each selected path is append-only user text; a later `read` result appends the requested contents through the ordinary tool transcript.

### Session model selection

#### What the model sees

The `/model` command text and keyboard-selector input are not logged or sent. New steps receive the selected provider/model pair in both prompt variables and request routing.

#### Token effect

The selector adds no messages. A target change may alter interpolated system-prompt text and sends subsequent requests to the selected model.

#### KV Cache effect

Changing provider or model enters that target's cache domain; no cache reuse across distinct targets is assumed.

### Manual skill invocation

#### What the model sees

A `/skill:<name> [instructions]` submission loads the named skill and delivers one text block: a `<skill name="…">` element wrapping the skill's instructions — preceded, when the provider exposes a resource base, by a line locating the skill's relative resources — followed by any trailing instructions the user typed. Delivery follows the same followup-while-idle / steer-while-running rule as ordinary input. The command, not the model, chooses the skill; model-disabled skills are omitted from autocomplete but stay loadable by exact name.

#### Token effect

The rendered skill block and trailing instructions are retained as one user turn under the agent loop's normal session-history and compaction rules; a repeated invocation appends the body again.

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

- **Resume has no cross-process session lock** — the selector rejects sessions known to be live in its own runtime, but another process can resume the same persisted id before or during handoff. Deployments that can run concurrent hosts must coordinate ownership outside the TUI.
- **One configured session owns the transcript and editor** — questions from other agents can still use the shared overlay provider, but session rendering and prompt input remain bound to `sessionId`.
- **Tool cards are text terminal presentations** — terminal, diff, and generic cards use tool-owned titles/content, but session content currently has no image block for inline image rendering.
- **Non-TTY operation is intentionally unsupported** — app bundles that need automation must compose a one-shot or server front door (`dsh-cli-demo`, `dsh-acp`) rather than expecting an internal fallback.
- **Manual `/skill:` invocation always reloads the full skill body** — the TUI does not detect a skill already present in the conversation, so repeated invocations append its instructions again.
- **File discovery is host-workspace discovery** — autocomplete reads the TUI process's session `cwd`, while the selected text is later interpreted by the configured `read` tool. Deployments that mount a remote or virtual filesystem must keep those namespaces aligned or provide another completion surface.
- **File search uses explicit directory exclusions, not ignore files** — `.git` and `node_modules` are excluded by default and deployments may configure more basenames, but `.gitignore` and `.ignore` are not interpreted. Directory symlinks are not traversed.
