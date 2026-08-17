# Agent Note: Local interactive CLI over the core Agent runtime

Status: implemented

English | [中文](2026-08-13-local-interactive-cli.zh.md)

## Problem

The product needs a local-terminal entry point that keeps one Agent and Session across ordinary follow-up turns. Repeating the one-shot headless command loses conversational state, while mounting the Web, ACP, or another protocol stack makes a terminal process depend on an unrelated transport. Human input is also shared runtime state: chat, credentials, approval requests, and model questions cannot safely create competing owners over one stdin.

Windows adds a separate composition constraint. The persistent terminal capability depends on POSIX process-group observation and cannot claim equivalent ConPTY lifecycle semantics, but omitting the unsupported provider must not prevent the local CLI from using the base PowerShell and filesystem tools.

## Decision

The TTY's immutable welcome output is a bordered blue pixel-whale card. The transcript, successful-tool rows, live status, and queued-message presentation remain compact below it.

The transcript separates user and assistant content with compact `YOU` and `DEEPCODE` labels. The mutable response is capped at its latest twelve lines because Windows CMD cannot erase content that a growing Ink frame has already scrolled into terminal history; turn completion commits the full response once. A lightweight renderer removes common Markdown control markers while preserving headings, lists, fenced code, and bold emphasis. A turn's tool calls remain represented by the live working state while they execute, then commit as one operation-count summary; failures remain individual rows, and Ctrl+O exposes the summary's raw call arguments.

The status row shows the foreground task's elapsed time and the age of its latest Session event. Authoritative `subagent/start` and `subagent/end` lifecycle events maintain an independent background count and oldest elapsed time; the one-second display clock runs only while either kind of work is active.

A separate live usage row reads the durable task-tree ledger rather than counting visible transcript rows. It reports cache-hit rate, billed and uncached input, and output; main-agent, auxiliary, and descendant usage share one denominator. Monetary cost remains unavailable until a route-aware price source supplies an estimate.

`deepseek` is the direct executable for the shipped `cli` profile; `dsh cli` and `dsh --profile cli` remain equivalent launcher forms. The Windows downloaded-source installer restores and builds the workspace, writes one direct `deepseek.cmd` launcher into npm's command directory, and persists that directory on the user's `PATH`, so a new Command Prompt, PowerShell, or Windows Terminal session reaches the same entry from every working directory. The launcher invokes the checkout's built entry without creating an npm package link, so the package cannot appear as a junction inside its own `node_modules` tree; both shells resolve the same `.cmd` without changing a Restricted script policy. Re-running the installer updates in place, while uninstall removes only the marked launcher without removing a shared npm PATH entry. Both launch forms set the process title to `DeepCode`. The profile bundle list is `@deepseek-ai/dsh-base` followed by `@deepseek-ai/dsh-cli-app`. Both executable names share one launcher dispatch and the CLI bundle contains one app-owned startup provider and direct runner; it mounts no Host, HTTP server, Web runtime, browser client, ACP server, or external-orchestrator integration.

The runner waits for Loader settlement, reads `ctx.agentDefaultModel.currentSelection()`, and creates one persisted Agent for the invoking directory through `ctx.agents.create`. A completed composer value becomes one ordinary user follow-up. `/new` replaces the owned Agent with a fresh Session; `/resume` uses `ctx.agents.resume` after checking identity, root origin, workspace, and absence of an Agent preset. Session headers do not identify the creating rosterless surface, so another rosterless session in the same workspace is eligible. The old Session is flushed and its handle is disposed only after the command completes. The runner waits for idleness and flushes after every turn and during final cleanup.

One surface owns the process's stdin. TTYs use one compact non-alternate-screen Ink tree; committed output enters an immutable `Static` region while streaming updates only the live response and composer, so token deltas do not redraw terminal scrollback. The live status row carries the current model, authentication, Session identity, and queued-message count without reprinting the static welcome row. A successful tool call commits one named row; its call arguments remain available through Ctrl+O, while a failed result adds a named error row. `/clear` replaces the Ink owner and emits the terminal screen-and-scrollback reset before drawing a fresh welcome row, so the old `Static` accumulator cannot later repaint cleared history. Redirected streams use a queued plain-text reader so lines that arrive before the next prompt are retained. While the Agent is running, the TTY composer retains complete chat messages in an in-memory FIFO; the runner dispatches each message through the existing follow-up path after the Agent becomes idle. Chat, masked credentials, the `approval/request` waterfall answerer, and the `ctx.userQuestions` provider serialize through that surface, and interactive requests take the composer while they are pending. Ctrl+C or Escape received while an Agent turn or cancellable plugin command is active cancels that operation; idle Ctrl+C, empty Ctrl+D, and stdin EOF produce a successful bounded shutdown. Listener and provider registrations are revoked on every exit path.

The built-in command layer owns `/login`, `/logout`, `/status`, `/model`, `/models`, `/new`, `/sessions`, `/resume`, `/clear`, `/help`, and `/exit`. Authentication derives the selected provider's credential reference from the LLM configurable-provider directory and resolved settings, then writes only through `ctx.credentials`; a secret is rejected in command argv and never reaches output or the Session log. Model discovery and selection delegate provider catalogs, exact model metadata, and reasoning-effort resolution to `ctx.llm`; the official route therefore shares the V4 Flash/V4 Pro settings catalog with the Web surface, while third-party routes remain discoverable. Other slash commands dispatch through `ctx.commands`, preserving plugin-owned `/compact`, `/goal`, and future contributions.

Committed `assistant/chunk` text deltas stream directly to stdout. When a step committed no text delta, its assembled `assistant/message` supplies the fallback; a step that streamed is not printed again. `turn/end` terminates the displayed line. Model-visible input remains reconstructable because user input, approvals, questions, tool activity, and assistant output continue through their existing Session event owners.

The CLI bundle mounts the existing `ask_user_question` Consumer and worker-thread Code Mode provider so model questions and `DSH_TOOLS_MODE=code|both` reach complete capability seams. It mounts the persistent terminal Service Definition, bash provider, and terminal-tool Consumer together on POSIX. All three terminal entries are disabled together on Windows, where `dsh-base` continues to supply the one-shot PowerShell tool and sandboxed filesystem tools. The profile makes no ConPTY claim.

The [profile plugin bundle decision](../architecture/2026-08-05-profile-plugin-bundles.md) owns layer composition and app-owned startup values. [Headless as a direct core entry point](../architecture/2026-08-09-headless-direct-core-entry-point.md) owns one-shot aggregation and exit-code semantics. The [persistent PTY decision](2026-07-16-persistent-pty-sessions.md) owns terminal lifecycle and tool behavior.

## Verification

Focused package tests pin startup-service activation, queued non-TTY and running-turn TTY input, one stdin owner, multiline editing, slash completion, secret masking, compact tool rows, multiple turns on one Agent, streamed-text deduplication, approval and question routing, command dispatch, active-turn cancellation, idle Ctrl+C and EOF shutdown, and flush-before-dispose ordering. Profile composition tests load the real base and CLI bundle patches without swallowing resolution failures and assert the platform-specific terminal entries. Built and source CLI smokes cover `deepseek --version`, app help, and a keyless command transcript without making a model request. The Windows installer acceptance uses an isolated npm prefix, runs installation twice, resolves `deepseek` by name in fresh CMD and Restricted-policy PowerShell processes, compares their versions, and verifies repeated uninstall removes the command.

## Alternatives considered

**Launch one headless process per line.** Rejected because each process creates a different Agent and Session, so follow-ups lose conversation state and repeated startup cannot coordinate pending human interactions.

**Drive the local terminal through Web, ACP, or JSON-RPC.** Rejected because the product path needs no network or client protocol. Those gateways retain their own transport validation and automation contracts instead of becoming dependencies of readline.

**Let each human-interaction consumer own terminal input.** Rejected because concurrent readers race for stdin, duplicate signal handlers, and can strand an approval, question, or masked credential prompt when chat resumes.

**Enable the POSIX terminal provider on Windows.** Rejected because process-group readiness and teardown are not ConPTY semantics. Disabling the complete terminal capability while retaining the base PowerShell tool is explicit and usable.

**Include external orchestration in the first release.** Deferred because local process ownership, cancellation, and transcript behavior are independently useful and testable. A later integration must compose through plugin APIs without changing the local CLI lifecycle.

## Consequences

The shipped CLI is a structured local terminal experience with durable multi-turn context, authentication, model/reasoning selection, session replacement and resume, plugin commands, interactive approvals and questions, and deterministic cleanup. The terminal shell is rich but assistant Markdown and tool-specific diff cards remain text; preset-composed sessions are refused rather than resumed under the wrong tools. POSIX users receive the existing persistent terminal tools; Windows users receive the base PowerShell and filesystem tools. External orchestration remains outside this release and does not block local-terminal acceptance.
