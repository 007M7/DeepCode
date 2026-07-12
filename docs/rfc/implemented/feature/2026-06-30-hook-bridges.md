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
| `subagent/start` (emit) | additionalContext → inject into the live child | — (not a Codex event) |
| `subagent/end` (emit) | observe-only | — |

### Context source is always the plugin (the mislabel guard)

`agent.inject()` defaults a missing `MessageSource` to `{ kind: 'user' }` — which would record plugin-injected context as if the user had typed it. So every bridge `inject()` and every `HookContext` passes an explicit `{ kind: 'plugin', plugin: 'hooks-claude' | 'hooks-codex' }` source. A test asserts the resulting `context/message.source` is the plugin, never `user`.

### Adding context is not a veto — delegate, then fold

A hook that only attaches `additionalContext` (no block/deny) is NOT a decision the bridge should return on its own: returning `allow`/`accept` from a waterfall listener WITHOUT calling `next()` short-circuits every later `agent/prompt-submit` / `tools/post-execute` listener, so a policy/sandbox plugin registered after the bridge would never see the prompt. So on the context-only path each bridge **delegates via `next()`** and then **folds** its `additionalContext` onto the downstream decision (`concatContext`). The fold differs by seam because the two Decision unions differ: `tools/post-execute` — a downstream `block`/`accept` both carry an `additionalContext` field, so the bridge context rides along either way (a downstream block wins AND keeps the context; a downstream accept keeps its content rewrite and gains the context). `agent/prompt-submit` — a downstream `allow` gains the bridge context (and keeps its own content rewrite / additionalContext), but `PromptDecision.block` carries no context field, so a downstream block drops the bridge context — which is correct: a blocked prompt never reaches the model, so context attached to it is moot. Only a real `deny`/`block` from the hook itself short-circuits. Tests assert a later listener can still block a prompt a context-only hook allowed, and that both contexts survive when the downstream also adds one.

### CLAUDE_PROJECT_DIR defaults to the session workspace

Claude Code always exports `CLAUDE_PROJECT_DIR`, and common unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths. An explicit `config.projectDir` wins; when it is omitted (the default ACP wiring configures only `configPath`), the bridge defaults the env var per-run to the agent's session workspace — the same `session.header.cwd` the hook already runs in — rather than leaving it empty. So a stock project-relative hook works in the default setup.

### Containment

The config is parsed ONCE at load; a read/parse failure logs and registers nothing rather than crashing boot (a typo'd path must not take the agent down). Only `type: 'command'` hooks run — a `prompt`/`agent`/HTTP hook (CC) or an `async: true` / non-command hook (Codex) is parsed-and-skipped with a warning. The emit-listener paths (`session-start`, `subagent/start`) run detached, with their `inject` contained in a `.catch` that logs (a throwing inject must not break session boot or the loop).

### Where hooks run, and where their config comes from

Two different cwds, kept distinct on purpose. The hooks **themselves** run in the agent's **session workspace**: for the agent-scoped points the bridge threads the session's `cwd` (`session/new.cwd`, on the session header) to `runHook` as the process working directory, so a hook's `pwd` / relative-file read / marker write operates in the user's project tree, not the server's launch directory. The **config path**, by contrast, is **process-level**: `configPath` is resolved and parsed once at load against the process launch cwd, so a single `hooks.json` applies to the whole process — there is no per-session config discovery that reads a project-local `hooks.json` from each `session/new.cwd` (`TODO(per-session-hook-config)`). This is an honest limitation of the current cut: the example `cordis.yml` documents that its `./hooks.json` is process-level, not per-project.

## Deferred (faithful-but-degraded)

- **Tool-input rewrite.** A CC/Codex `updatedInput` is logged + warned, not honored — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite RFC](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)), because the pre-execution args are read by `tool/call` audit + `assistant/message` history + ACP/tool-bash presentation, so an honest rewrite is a design unit, not a field.
- **Stop loop-guard** (`TODO(stop-loop-guard)`). CC/Codex break an infinite force-continue with `stop_hook_active` (true once a Stop hook fired this run) plus a max-consecutive cap; both are deferred. Today `stop_hook_active` is always `false`, so a Stop hook that unconditionally blocks would force-continue every step — a hook author must self-limit until the guard lands.
- **Permission `ask`** — deferred at landing, since serviced: the [approval seam](2026-07-06-approval-seam.md) resolves `ask` through `ctx.approval` (ACP prompts over `session/request_permission`), degrading to `deny` only where no approval service is composed.
- **Hook `continue:false` (hard halt).** A hook can ask to halt the whole run (CC/Codex `continue:false`); the shared merge folds it into `MergedHookOutcome.stop`/`stopReason`, but no bridge acts on it (`TODO(hook-continue-false)`) — the interception seams have no "hard-halt the agent" primitive yet (a Decision blocks/steers a single point, not the run). Deferred with the loop-guard work; the halt request is recorded in the `hook/result` log, and the hook keeps its per-point effect (decision/context) meanwhile.
- **Config discovery.** The path is explicit in `cordis.yml` and process-level (see above); the full multi-layer CC/Codex precedence walk, per-session project-local discovery, and the trust/hash model are not reimplemented (`TODO(per-session-hook-config)`).
- **Session-start / subagent-start context is best-effort, not gated (`TODO(session-start-gating)`).** `agent/session-start` is a synchronous emit and the bridge runs its hook on a detached `.then`, so the injected `additionalContext` is not guaranteed to land before the first turn reaches the model — a slow hook can miss the first request (the context then arrives as a later injection). `subagent/start` is sharper: an in-process provider may have already queued the child's prompt before the listener runs, and a short-lived child can finish before the detached inject fires. Making startup context a gated/awaited primitive is a loop-level change deferred to the interception seams; today the contract is "injected as soon as the hook resolves", not "before the first request". The bridge tests do NOT wait on the injection where they assert the guaranteed-timing behavior, so they document the real (best-effort) timing rather than masking it.

## Alternatives considered

**Concurrent per-point hook execution.** The reference engines run a point's matched hooks concurrently and fold the results. These bridges run them **serially** (`await` per hook inside the match loop) and fold with the same most-restrictive merge. Serial is deliberate: it keeps each hook's `hook/invoked`/`hook/result` pair adjacent and in a deterministic order in the session log, and the fold is order-independent for the decision (`deny > ask > allow`) so the outcome matches. The cost is latency (hook *N* waits for hook *N−1*) and that per-hook timeouts are not overlapped — acceptable for the hook counts real configs use; revisit if a config ever fans out enough for the wall-clock to matter.

## Consequences

The bridges are thin and readable standalone: the correctness-critical halves (matcher semantics, exit-code contract, merge precedence) live in the shared `dsh-hook-protocol`, so each bridge is just config-parse + payload-build + outcome-map. Each is covered at per-file 100% — config-parse branches as unit tests, and the seam mappings end-to-end through the REAL loop + REAL `dsh-bash-local` + REAL shell scripts from a temp `hooks.json` (a scripted mock MODEL is the only stand-in), plus a real-Loader export-shape guard so a stray default export can't silently drop `inject`. Because the seams already carry typed Decisions, a future native plugin needs none of this bridge machinery — it returns a Decision directly.
