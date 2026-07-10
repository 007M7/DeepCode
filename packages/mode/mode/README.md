# @deepseek-ai/dsh-mode

Session modes: named, logged, per-agent policy states. **Plan mode** is the first shipped definition — the agent explores and designs under a read-only tool policy, produces a reviewable plan, and crosses back into full authority through an explicit review.

## The mode state is a session event

`mode/set` (`{ mode: string }`) is a log-only, non-surface `SessionEventMap` member with whole-value-replace semantics; the pure `foldMode(events)` returns the mode in force (the last `mode/set`, else `default`). Because the log is the fact channel, resume, fork, and compaction restore the mode with no extra machinery, and UIs read flips off `session/event` — there is no live mirror.

The `default` mode is the absence of policy: no section, no filtering, no gate. An agent that never sees a `mode/set` behaves byte-identically to a deployment that never loads this plugin.

## Two layers of enforcement

**Soft — what the model sees.** A `system-prompt/assemble` listener filters the returned assembly's tools down to the mode's allowlist and the `mode:policy` section (order 50) renders the mode's guidance text. Every transition therefore surfaces as an attributable `request/header` event on the next step (a delta when expressible; adding `exit_plan_mode` resorts the canonical tool list, which the delta encoding cannot express, so entering plan mode logs the full fallback snapshot). The `exit_plan_mode` tool is visible IFF the folded mode is `plan` — on the wire and, under the registry's Code Mode, in the `tools:sdk` section alike.

**Hard — what can run.** A `tools/pre-execute` listener denies, deny-by-default against the same allowlist, any call the mode does not permit — a hallucinated call to a still-registered (or freshly re-widened) tool cannot run. Agent-less executions and the default mode pass through; the gate judges by the LOGGED mode only, never a pending intent. `run_code` passes both layers as a TRANSPORT: under the registry's Code Mode it is the only wire tool, every bridged sub-call re-enters this gate with the same agent, and the `tools:sdk` section is re-rendered under the mode's visibility rule — the allowlist governs each capability individually and the prompt documents exactly the callable set.

## `ctx.modes`

`list()` returns the selectable vocabulary (`default` first, then the configured definitions); `get(agent)` returns the folded mode (a folded name the config no longer defines reads as `default`) plus any pending intent; `set(agent, mode)` validates against `list()` (loud on unknown; `default` is always a valid target) and records a pending intent — every session event is turn-enclosed and an idle agent has no open turn, so the service flushes the intent at the next `turn/start`/`step/end` and, when the flushed mode differs from what the last logged request header told the model, appends one coalesced `context/message` notice in the same frame. A net-zero flip sequence appends nothing.

`AgentOptions.mode` (declaration-merged) seeds a child's initial mode through the same pending-intent flush; explicit options beat the logged baseline on create AND resume. A fork child needs no mechanism — the parent's `mode/set` is inside the seeded prefix.

## `exit_plan_mode`

The model-facing exit tool. Its single required argument is the plan text — a durable, replayable log artifact riding the ordinary `tool/call` event. `execute` re-checks the folded mode, then conducts the review over the user-interaction seam (`ctx.get('userInteraction')`, opportunistic): one single-select question — Approve, or Keep planning — with the free-text channel open. Approve records the switch back to `default` as a silent boundary-applied pending intent (flushed at this step's end — the gate stays plan-mode for any remaining call of the same assistant response) and the next step's assembly restores the full toolset; every other outcome (keep-planning with the user's feedback verbatim, an aborted question, no provider) returns the corrective `isError` and the mode stays `plan`. `presentCall` renders a `generic` card titled by the plan's first heading with the plan markdown as content; over ACP the review rides the same elicitation flow as `ask_user_question`, in the terminal the stdio provider's prompt queue.

## Config

```yaml
- id: mode
  name: '@deepseek-ai/dsh-mode'
  config:
    modes:
      plan:
        section: |
          You are in plan mode: ...
        tools: [read, todo_write, web_search, web_fetch, ask_user_question, structured_output, exit_plan_mode]
```

Definitions are validated at load (`resolveConfig`): the built-in `plan` (read-only allowlist plus the ask/report channels `ask_user_question`/`structured_output`, `bash`/`subagent` excluded) merges unless overridden, `default` is rejected as a key, and allowlists may name not-yet-registered tools (registration is dynamic). An unknown name fails loudly at `set()` time.

RFC: [plan mode](../../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).
