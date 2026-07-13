# @deepseek-ai/dsh-mode

Session modes: named, logged, per-agent policy states. **Plan mode** is the first shipped definition — the agent explores and designs under a read-only stance, produces a reviewable plan, and crosses back into full authority through an explicit review.

## The mode state is a session event

`mode/set` (`{ mode: string }`) is a log-only, non-surface `SessionEventMap` member with whole-value-replace semantics; the pure `foldMode(events)` returns the mode in force (the last `mode/set`, else `default`). Because the log is the fact channel, resume, fork, and compaction restore the mode with no extra machinery, and UIs read flips off `session/event` — there is no live mirror.

The `default` mode is the absence of policy: no section, no cap. An agent that never sees a `mode/set` behaves byte-identically to a deployment that never loads this plugin.

## What a mode enforces

**The guidance section.** A `system-prompt/assemble` listener renders the mode's `section` text as the `mode:policy` section (order 50) while the mode is in force, and shows the `exit_plan_mode` tool IFF the folded mode is `plan` — on the wire and, under the registry's Code Mode, in the `tools:sdk` section alike. Every transition therefore surfaces as an attributable `request/header` event on the next step (entering plan adds the exit tool, a front-of-list insertion with no delta form → the full fallback snapshot; the approved exit removes exactly that tool and the section, a pure removal → one `request/header-delta`).

**The `access` cap.** A definition may declare `access` — the widest sandbox access shell commands run under while the mode is in force, on the `SANDBOX_MODES` ladder from [`@deepseek-ai/dsh-bash`](../../bash/bash/) (`read-only` | `workspace-write` | `danger-full-access`). The built-in `plan` ships `access: 'read-only'`: exploration commands run for real, and a write is denied by the sandbox itself. The cap is a **clamp, not a switch**: a `bash/resolve-mode` waterfall listener returns `min(resolved, access)` on the ladder. The session's own sandbox-mode knob (`bash/sandbox-mode` events) is never written — the two folds compose at read time, so the knob and the mode switch in any order without disturbing each other, and a knob flipped during plan re-emerges intact on exit. Two guards ride with a declared cap: the bash trio (`bash`/`bash_output`/`bash_kill`) is hidden and denied while no confining executor is mounted (`ctx.bash.sandboxMode` unset — an unconfinable shell cannot honor the cap), and a `bash` call carrying `sandbox_permissions` is denied outright (the cap would otherwise be pierceable mid-mode by one approval prompt). A mode without `access` gets neither guard.

**Deliberately absent: a tool allow/deny list.** Which tools a mode admits is an effects question — a per-tool read-only/mutating classification the harness does not yet have. Until tool definitions declare their effects (the plan-mode RFC's deferred item), a mode's non-shell restraint is the section's guidance and its shell restraint is the sandbox; the config vocabulary is exactly `{ section, access? }`, and an unknown key (a `tools` list included) fails loud at load.

## `ctx.modes`

`list()` returns the selectable vocabulary (`default` first, then the configured definitions); `get(agent)` returns the folded mode (a folded name the config no longer defines reads as `default`) plus any pending intent; `set(agent, mode)` validates against `list()` (loud on unknown; `default` is always a valid target) and records a pending intent — every session event is turn-enclosed and an idle agent has no open turn, so the service flushes the intent on the loop's interception seams (`agent/prompt-submit` inside the just-opened turn, `agent/turn-continuation` after each step closed — both outside any log emit, where a post-commit `session/event` observer could not append) and, when the flushed mode differs from what the last logged request header told the model, appends one coalesced `context/message` notice in the same frame. A net-zero flip sequence appends nothing.

`AgentOptions.mode` (declaration-merged) seeds a child's initial mode through the same pending-intent flush; explicit options beat the logged baseline on create AND resume. A fork child needs no mechanism — the parent's `mode/set` is inside the seeded prefix.

## `exit_plan_mode`

The model-facing exit tool. Its single required argument is the plan text — a durable, replayable log artifact riding the ordinary `tool/call` event. `execute` re-checks the folded mode, then conducts the review over the user-interaction seam (`ctx.get('userInteraction')`, opportunistic): one single-select question — Approve, or Keep planning — with the free-text channel open. Approve records the switch back to `default` as a silent boundary-applied pending intent (flushed at this step's end — the plan policy, the sandbox clamp included, keeps holding for any remaining call of the same assistant response) and the next step runs unclamped; every other outcome (keep-planning with the user's feedback verbatim, an aborted question, no provider) returns the corrective `isError` and the mode stays `plan`. `presentCall` renders a `generic` card titled by the plan's first heading with the plan markdown as content; over ACP the review rides the same elicitation flow as `ask_user_question`, in the terminal the stdio provider's prompt queue.

## Config

```yaml
- id: mode
  name: '@deepseek-ai/dsh-mode'
  config:
    modes:
      plan:
        section: |
          You are in plan mode: ...
        access: read-only
```

Definitions are validated at load (`resolveConfig`): the built-in `plan` (the shipped guidance section plus `access: read-only`) merges unless overridden, `default` is rejected as a key, an `access` outside the `SANDBOX_MODES` ladder throws, and any other key — a `tools` list included — fails loud. An unknown mode name fails loudly at `set()` time.

RFC: [plan mode](../../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).
