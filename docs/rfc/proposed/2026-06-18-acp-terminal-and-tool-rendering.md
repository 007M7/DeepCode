# RFC: Rich ACP bash rendering — the terminal sub-protocol and command classification

Status: proposed

## Problem

The ACP bridge now lets each tool own its call rendering via `presentCall`/`presentResult` (see [tool-call UI presentation](2026-06-14-acp-agent-client-protocol.md) and `packages/tools`). For `bash` we surface the model's `description` plus the command as the `tool_call` title, `kind: 'execute'`, and the completed output wrapped in a fenced ` ```console ` text block.

That is a correct, capability-free MVP, but it is not how the reference editors render a *terminal* tool at its best. Two gaps:

1. **No live terminal card.** An editor like Zed has a dedicated terminal tool-call card — a header showing the working directory, the command, a copy button, and **streaming** output with an exit-status pill — but it only uses that card when the `tool_call`'s `content` is an ACP `terminal` block (`{ type: 'terminal', terminalId }`), not a text block. With a text block the command output appears only as static markdown *after the turn completes*; there is no live stream and no cwd header. (Zed also HIDES `rawInput` for `kind: 'execute'`, which is why our command currently has to ride inside the title.)

2. **No command classification.** A bash invocation is opaque — `bash -lc "sed -n 1,40p foo.ts"` is really a file read, `rg foo` is a search. The reference adapters classify common commands and present them with a *semantic* kind/title/locations (a `read` card titled "Read file 'foo.ts'" with a follow-along file location, a `search` card), falling back to a terminal card only for an unrecognized command. This is what makes one bash call render with a search icon and "List …" while the next renders as a raw terminal.

## What the reference adapters do (studied 2026-06-18)

- **`codex-acp`** (`CodexToolCallMapper.ts`): classifies each command into `commandActions`. A recognized action maps to a semantic update — `read` → `{kind:'read', title:"Read file '…'", locations:[{path}]}`, `search` → `{kind:'search', title:"Search for '…' in …"}`, `listFiles` → `{kind:'read', title:"List files in '…'"}`. An `unknown` action becomes a terminal card: `{kind:'execute', title: stripShellPrefix(command), content:[{type:'terminal', terminalId}], _meta:{terminal_info:{cwd, terminal_id}}}`. The `_meta.terminal_info.cwd` is what renders the working directory as the card header.
- **`claude-agent-acp`** (`tools.ts`): gates on `clientCapabilities._meta.terminal_output`. WITH it: a terminal content block plus `_meta.terminal_{info,output,exit}` (output + exit code). WITHOUT it: the same fenced ` ```console ` text-block fallback this bridge ships today. Title is the command; the model's `description` (when present) is shown as content.
- **Zed** (`crates/agent_ui/.../thread_view.rs`, `crates/acp_thread/.../acp_thread.rs`): `render_terminal_tool_call` reads the terminal's `working_dir` as the header and `tool_call.label` (the title) as the command; a non-terminal text `content` block renders via `render_markdown_output`. `should_show_raw_input = !is_terminal_tool` confirms `rawInput` is suppressed for execute-kind cards.

The full terminal experience is an ACP **sub-protocol**, not just a content shape: the client advertises a terminal capability, and the agent drives `terminal/create` → streams via `terminal/output` → `terminal/release`, attaching the `terminalId` to the `tool_call` content. That is a cross-seam feature (bridge ⇄ `dsh-bash` executor ⇄ client), which is why it is deferred to this RFC rather than folded into the presentation-seam PR.

## Proposal

Two independent, separately shippable pieces. Both build on the existing tool-owned presentation seam — neither reintroduces tool-name special-casing in the bridge.

### A. Terminal content type + cwd metadata (capability-gated)

1. In `initialize`, read the client's terminal capability (`clientCapabilities.terminal` / the `_meta.terminal_output` convention the references use) and remember it per connection.
2. Extend the `dsh-tools` presentation vocabulary so a tool can ask for a terminal rendering — e.g. a `ToolResultPresentation`/`ToolCallPresentation` variant carrying `{ kind: 'terminal', cwd, terminalId? }` (provider-neutral; the bridge maps it to the ACP `terminal` content block + `_meta.terminal_info`). `dsh-tool-bash` returns it for `bash` when a cwd is known.
3. When the client supports it, the bridge maps that to `content:[{type:'terminal', terminalId}]` + `_meta.terminal_info.{cwd,terminal_id}`; otherwise it keeps the current ` ```console ` text fallback. The fenced-text path stays the guaranteed baseline.
4. *(Stretch)* drive live streaming through the real `terminal/*` methods so output appears as it is produced, with an exit-status pill — this needs a streaming seam on `dsh-bash` (the executor already has the process; it would push incremental output to the bridge). Scope this as a follow-up sub-step; steps 1–3 already give the cwd-header card with output attached at completion.

### B. Command classification (capability-free)

A small, pure classifier (in `dsh-tool-bash`, since it owns the bash schema) maps a command string to an optional semantic presentation: detect common read/search/list shapes (`cat`/`sed -n`/`head`/`tail` → `read` + a `path` location; `grep`/`rg` → `search`; `ls` → list) and return the richer `ToolCallPresentation` (`kind`, a human title, `locations`). Anything unrecognized falls through to the current execute/terminal presentation. This needs a `locations?: ToolCallLocation[]`-style field on `ToolCallPresentation` (neutral `{ path, line? }`), which the bridge maps to ACP `tool_call.locations` to drive editor "follow-along".

Classification is best-effort and explicitly fallible: a misparse must degrade to the plain terminal card, never mislabel destructively (e.g. never title a `rm` as a "read"). Keep the matcher conservative and unit-test each recognized shape plus the fallthrough.

## Risks / trade-offs

- **Terminal sub-protocol is cross-seam and stateful.** Live streaming couples the bridge, the `dsh-bash` executor, and the client's terminal lifecycle; getting disposal/cancel right (release the terminal on turn end, abort, and disconnect) is the hard part — it must honor the same quiescence rules as the rest of the bridge. Steps A1–A3 (static cwd header + output at completion) are low-risk; A4 (live streaming) is where the lifecycle complexity lives.
- **Capability detection must stay honest.** Advertise/emit terminal content only when the client opted in; the text fallback is the contract for everyone else, so it must never regress.
- **Classification can mislead.** A wrong guess is worse than no guess. Bias to the terminal fallback; treat the classifier as additive polish, not a correctness path. (Security note: classification is display-only — it must never change what actually executes.)
- **Provider-neutral vocabulary creep.** Adding `terminal`/`locations` to `ToolCallPresentation` widens the `dsh-tools` surface. Keep the additions neutral (no ACP types leak into `dsh-tools`) and only as rich as a second consumer would also want.

## Out of scope / non-goals

The MVP shipped in the tool-call-UI PR (description+command title, `kind:'execute'`, ` ```console ` output fallback) stays the baseline and the no-capability default. This RFC is purely additive polish on top of it.
