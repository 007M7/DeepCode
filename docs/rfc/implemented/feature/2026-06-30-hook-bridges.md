# RFC: dsh-hooks-claude + dsh-hooks-codex — the Claude Code / Codex hook bridges

Status: implemented

## Problem

The harness's extension surface is its typed interception seams ([the interception-seams RFC](2026-06-30-interception-seams.md)): a "native hook" is just an ordinary cordis plugin subscribing to `agent/session-start`, `agent/prompt-submit`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-continuation`, `subagent/start`, `subagent/end`. But users arrive with **existing** Claude Code (CC) and Codex hook configs — a `hooks.json` (or a settings file's `hooks` key) full of shell-command hooks — and want those to run unmodified. This RFC introduces the two **bridge plugins** that translate that external shell-hook protocol onto the typed seams, built on the shared wire-protocol library ([the hook-protocol-lib RFC](2026-06-30-hook-protocol-lib.md)).

The framing that shapes the whole design: **a bridge is a faithfulness adapter, not a power tool.** Anything a bridge does (block a tool, inject context, force continuation, observe a subagent) a native cordis plugin does more powerfully — typed returns, full `ctx`, no serialization boundary. The bridge's only reason to exist is to run an UNMODIFIED external CC/Codex hook with byte-faithful semantics. That keeps each bridge thin: parse the config, pick a matcher mode, build the per-event payload, call `runHook` + `mergeHookOutputs` from the shared lib, map the neutral outcome onto a seam Decision.

## Decision

Two independent plugins in the `packages/hooks/` group, each a function/namespace plugin (`name`/`inject`/`Config`/`apply`, NO default export — see [postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md)) injecting only `bash`:

- **`dsh-hooks-claude`** — the CC dialect. Seven hook points: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`. Owns CC's per-event stdin payloads (a base of `session_id`/`cwd`/`hook_event_name` plus per-event fields), CC's env + `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution, and the literal-or-regex matcher mode. A CC hook's stdin carries a **trailing newline**.
- **`dsh-hooks-codex`** — the Codex dialect: a deliberate SUBSET. Five hook points (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop` — no subagent/notification/compaction), an always-regex matcher, snake_case payloads with `turn_id`/`model`/`permission_mode` extras written WITHOUT a trailing newline, no env and no `${…}` substitution, and a block-only decision model (a Codex hook can never pre-approve, so `allow`/`ask` are not honored). A tool call's payload carries the real `tool_name` (the value the matcher tests, so a config's tool matcher fires) in Codex's `tool_input: { command }` shape.

### Outcome → Decision mapping

Each bridge maps the neutral `MergedHookOutcome` from the shared lib onto the seam's typed Decision:

| Seam | CC | Codex |
|---|---|---|
| `agent/session-start` (emit) | additionalContext → `agent.inject()` | plain-stdout output → additionalContext → `agent.inject()` |
| `agent/prompt-submit` | `deny`→`block`; context-only→delegate+fold | `block`→`block`; context-only→delegate+fold |
| `tools/pre-execute` | `deny`→`deny`; `ask`→`ask` | `block`→`deny` (no allow/ask) |
| `tools/post-execute` | `deny`→`block`+feedback; context-only→delegate+fold | same |
| `agent/turn-continuation` | blocking Stop → `continue` (reason = next-step steering) | same |
| `subagent/start` (emit) | additionalContext → inject into a live in-process child; a remote child has no local injection target | — (not a Codex event) |
| `subagent/end` (emit) | observe-only | — |

The CC bridge's `ask` result is a real permission path, not a terminal bridge decision: `dsh-tools` resolves it through the optional [approval seam](2026-07-06-approval-seam.md). A composed ACP answerer prompts the owning editor session and `allowed-once` proceeds; without an ApprovalService or answerer, the call fails closed to `deny`.

### Context source is always the plugin (the mislabel guard)

`agent.inject()` defaults a missing `MessageSource` to `{ kind: 'user' }` — which would record plugin-injected context as if the user had typed it. So every bridge `inject()` and every `HookContext` passes an explicit `{ kind: 'plugin', plugin: 'hooks-claude' | 'hooks-codex' }` source. A test asserts the resulting `context/message.source` is the plugin, never `user`.

### Adding context is not a veto — delegate, then fold

A context-only hook must call `next()` and then fold its `additionalContext` into the downstream decision; returning allow or accept directly would bypass later policy listeners. Post-tool block and accept decisions both preserve added context. Prompt allow preserves it, while prompt block drops it because the prompt never reaches the model. Only an explicit hook denial or block short-circuits the waterfall.

### CLAUDE_PROJECT_DIR defaults to the session workspace

Claude Code always exports `CLAUDE_PROJECT_DIR`, and common unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths. An explicit `config.projectDir` wins; when it is omitted (the default ACP wiring configures only `configPath`), the bridge defaults the env var per-run to the agent's session workspace — the same `session.header.cwd` the hook already runs in — rather than leaving it empty. So a stock project-relative hook works in the default setup.

### Containment

The config is parsed ONCE at load; a read/parse failure logs and registers nothing rather than crashing boot (a typo'd path must not take the agent down). Only `type: 'command'` hooks run — a `prompt`/`agent`/HTTP hook (CC) or an `async: true` / non-command hook (Codex) is parsed-and-skipped with a warning. The emit-listener paths (`session-start`, `subagent/start`) run detached, with their `inject` contained in a `.catch` that logs (a throwing inject must not break session boot or the loop).

### Where hooks run, and where their config comes from

Hooks run in the agent's session workspace, so relative paths target the user's project. `configPath` is resolved once against the process launch cwd and applies to every session. Per-session project-local discovery remains deferred under `TODO(per-session-hook-config)`.

## Deferred (faithful-but-degraded)

- **Tool-input rewrite.** A CC/Codex `updatedInput` is logged + warned, not honored — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite RFC](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)), because the pre-execution args are read by `tool/call` audit + `assistant/message` history + ACP/tool-bash presentation, so an honest rewrite is a design unit, not a field.
- **Stop loop-guard** (`TODO(stop-loop-guard)`). CC/Codex break an infinite force-continue with `stop_hook_active` (true once a Stop hook fired this run) plus a max-consecutive cap; both are deferred. `stop_hook_active` is always `false`, so a Stop hook that unconditionally blocks would force-continue every step — a hook author must self-limit until the guard lands.
- **Hook `continue:false` (hard halt).** A hook can ask to halt the whole run (CC/Codex `continue:false`); the shared merge folds it into `MergedHookOutcome.stop`/`stopReason`, but no bridge acts on it (`TODO(hook-continue-false)`) — the interception seams have no "hard-halt the agent" primitive yet (a Decision blocks/steers a single point, not the run). Deferred with the loop-guard work; the halt request is recorded in the `hook/result` log, and the hook keeps its per-point effect (decision/context) meanwhile.
- **Config discovery.** The path is explicit in `cordis.yml` and process-level (see above); the full multi-layer CC/Codex precedence walk, per-session project-local discovery, and the trust/hash model are not reimplemented (`TODO(per-session-hook-config)`).
- **Session-start / subagent-start context is best-effort (`TODO(session-start-gating)`).** Both hooks run detached from startup, so their context is injected when ready but may miss the first request or a short-lived child. Guaranteeing first-request delivery requires an awaited startup seam.

## Alternatives considered

**Concurrent per-point hook execution.** The reference engines run a point's matched hooks concurrently and fold the results. These bridges run them **serially** (`await` per hook inside the match loop) and fold with the same most-restrictive merge. Serial is deliberate: it keeps each hook's `hook/invoked`/`hook/result` pair adjacent and in a deterministic order in the session log, and the fold is order-independent for the decision (`deny > ask > allow`) so the outcome matches. The cost is latency (hook *N* waits for hook *N−1*) and that per-hook timeouts are not overlapped — acceptable for the hook counts real configs use; revisit if a config ever fans out enough for the wall-clock to matter.

## Consequences

Matcher semantics, exit-code handling, and merge precedence live in `dsh-hook-protocol`; each bridge only parses config, builds dialect payloads, and maps outcomes. Per-file coverage includes config branches plus end-to-end mappings through a real loop, `dsh-bash-local`, and shell scripts, while a real-Loader smoke guards the package export shape. Native plugins bypass the wire protocol and return typed decisions directly.
