# `@deepseek-ai/dsh-cli-app`

English | [中文](README.zh.md)

The local interactive CLI bundle. [`cordis.patch.yml`](cordis.patch.yml) layers directly over [`dsh-base`](../base/README.md), mounts this package's command-line startup provider and direct Agent runner, and adds the existing persistent terminal capability on supported non-Windows hosts. It mounts no Host, HTTP server, Web runtime, browser plugin, or ACP server.

Start it with `deepseek`, `dsh cli`, or `dsh --profile cli`. A TTY receives an Ink-based, non-alternate-screen interface with the blue pixel whale, durable terminal scrollback, streamed answers, tool activity, a live status line, selectable approvals and questions, command completion, input history, and a masked credential prompt. Redirected stdin/stdout use deterministic plain text without ANSI escapes. One surface owns stdin for chat, credentials, approvals, and model questions; an active Ctrl+C cancels work, while idle Ctrl+C or EOF performs a bounded shutdown.

The built-in command set is `/login`, `/logout`, `/status`, `/model`, `/models`, `/new`, `/sessions`, `/resume`, `/clear`, `/help`, and `/exit`. `/login` resolves the selected provider's configured credential reference and writes through `ctx.credentials`; the key never appears in argv, terminal output, settings, or the Session log. `/models` and `/model` consume provider discovery through `ctx.llm`, so the official DeepSeek route advertises V4 Flash and V4 Pro by default while a Web/settings catalog replacement is visible without a CLI-specific model list. Model selection also resolves the provider's thinking and reasoning-effort metadata. `/resume` accepts only rosterless root sessions from the invoking workspace and refuses sessions carrying an Agent preset. Other commands, including `/compact` and `/goal`, dispatch through the plugin command registry.

Keyboard behavior follows established coding-agent terminal conventions: Enter sends, Backspace deletes the preceding character on CMD and POSIX terminals, Ctrl+J or Shift+Enter inserts a newline, Up/Down traverses history or picker choices, Tab completes a unique slash command, Ctrl+A/E moves to the line edges, Ctrl+U/K/W edits the buffer, Ctrl+L clears, Ctrl+O toggles tool details, Ctrl+N starts a session, Escape or Ctrl+C cancels active work, and idle Ctrl+C or empty Ctrl+D exits. Shutdown flushes the current Session before disposing its Agent handle and requesting exit through `ctx.appExit`.

The base bundle continues to own filesystem policy, filesystem tools, approval policy, permission presets, and the platform's one-shot shell tool. This bundle mounts `@deepseek-ai/dsh-tool-ask-user`, contributes the human answerer for `ctx.approval`, and provides the terminal answerer for `ctx.userQuestions`, so model questions use the same input owner as approvals and chat. It also mounts the worker-thread code runtime used when `DSH_TOOLS_MODE` selects `code` or `both`. On POSIX it mounts `@deepseek-ai/dsh-terminal`, `@deepseek-ai/dsh-terminal-bash`, and `@deepseek-ai/dsh-tool-terminal` as one capability seam. Those three rows are disabled together on Windows; the CLI remains usable there through the base PowerShell tool and does not claim ConPTY support.

## Model Experience

None, as the terminal runner submits ordinary user messages; prompts, tools, and command-owned model context belong to the composed plugins.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **Plain content rendering** — the terminal shell is structured, but assistant Markdown and tool-specific diff cards currently render as text; alternate-screen ownership is intentionally not used so scrollback remains available.
- **Rosterless resume only** — this profile resumes root sessions from the current workspace and refuses sessions carrying an Agent preset. Session headers do not identify which rosterless surface created them, so another rosterless profile in the same workspace remains eligible.
- **No Windows persistent PTY** — Windows uses the base PowerShell tool until a Windows-native terminal provider owns ConPTY process and signal semantics.
- **No external-orchestrator integration** — the first release owns only the local terminal process; remote dispatch and lifecycle reporting are outside this bundle.
