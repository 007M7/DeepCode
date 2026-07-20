# @deepseek-ai/dsh-mode

Session modes: named, logged, per-agent COLLABORATION states. **Plan mode** is the first shipped definition — the agent explores and designs under a planning stance, produces a reviewable plan, and crosses back through an explicit review. Modes are one axis; enforcement knobs (the sandbox mode, the approval policy) are others — they never read or write each other, matching how Codex keeps its Plan/Default collaboration presets separate from its sandbox and approval settings.

## The mode state is a session event

`mode/set` (`{ mode: string }`) is a log-only, non-surface `SessionEventMap` member with whole-value-replace semantics; the pure `foldMode(events)` returns the mode in force (the last `mode/set`, else `default`). Because the log is the fact channel, resume, fork, and compaction restore the mode with no extra machinery, and UIs read flips off `session/event` — there is no live mirror.

The `default` mode is the absence of policy: no section, no extra tool. An agent that never sees a `mode/set` behaves byte-identically to a deployment that never loads this plugin.

## What a mode carries

**The guidance section.** A `system-prompt/assemble` listener renders the mode's `section` text as the `mode:policy` section (order 50) while the mode is in force, and shows the `exit_plan_mode` tool IFF the folded mode is `plan` — on the wire and, under the registry's Code Mode, in the `tools:sdk` section alike. Every transition therefore surfaces as an attributable `request/header` event on the next step (entering plan adds the exit tool at its canonical alphabetical position — a non-tail insertion the append-only tools delta cannot express → the full fallback snapshot; the approved exit removes exactly that tool and the section, a pure removal → one `request/header-delta`).

**Deliberately absent: enforcement.** A mode never gates execution, filters the toolset, or touches the sandbox/approval knobs — those are independent axes the user switches separately (a deployment that wants a hard read-only floor while planning flips the sandbox-mode option beside the mode picker, in either order; neither disturbs the other). A per-mode tool allow/deny list is likewise out: which tools a mode admits is an effects question — a per-tool read-only/mutating classification the harness does not yet have — parked until tool definitions declare their effects (the plan-mode RFC's deferred item). The config vocabulary is exactly `{ section }`, and an unknown key (a `tools` list or an `access` cap included) fails loud at load.

## `ctx.modes`

`list()` returns the selectable vocabulary (`default` first, then the configured definitions); `get(agent)` returns the folded mode (a folded name the config no longer defines reads as `default`) plus any pending intent; `set(agent, mode)` validates against `list()` (loud on unknown; `default` is always a valid target) and records a pending intent — every session event is turn-enclosed and an idle agent has no open turn, so the service flushes the intent on the loop's interception seams (`agent/prompt-submit` inside the just-opened turn, `agent/turn-continuation` after each step closed — both outside any log emit, where a post-commit `session/event` observer could not append) and, when the flushed mode differs from what the last logged request header told the model, appends one coalesced `context/message` notice in the same frame. A net-zero flip sequence appends nothing.

`AgentOptions.mode` (declaration-merged) seeds a child's initial mode through the same pending-intent flush; explicit options beat the logged baseline on create AND resume. A fork child needs no mechanism — the parent's `mode/set` is inside the seeded prefix.

## `exit_plan_mode`

The model-facing exit tool. Its single required argument is the plan text — a durable, replayable log artifact riding the ordinary `tool/call` event. `execute` re-checks the folded mode, then conducts the review over the user-interaction seam (`ctx.get('userInteraction')`, opportunistic): one single-select question — Approve, or Keep planning — with the free-text channel open. Approve records the switch back to `default` as a silent boundary-applied pending intent (flushed at this step's end — the plan surface keeps holding for any remaining call of the same assistant response) and the next step reflects the exit; every other outcome (keep-planning with the user's feedback verbatim, an aborted question, no provider) returns the corrective `isError` and the mode stays `plan`. `presentCall` renders a `generic` card titled by the plan's first heading with the plan markdown as content; over ACP the review rides the same elicitation flow as `ask_user_question`, in the terminal the stdio provider's prompt queue.

## Config

```yaml
- id: mode
  name: '@deepseek-ai/dsh-mode'
  config:
    modes:
      plan:
        section: |
          You are in plan mode: ...
```

Definitions are validated at load (`resolveConfig`): the built-in `plan` (the shipped guidance section) merges unless overridden, `default` is rejected as a key, and any other key — a `tools` list or an `access` cap included — fails loud. An unknown mode name fails loudly at `set()` time.

## Model Experience

### System prompt

**What the model sees**: In the default mode, nothing — assemblies are byte-identical to a deployment without this plugin (the always-registered `exit_plan_mode` tool is filtered from the wire and the Code Mode SDK). In a non-default mode, the mode's `section` renders as the `mode:policy` section (order 50) and, in plan mode, the `exit_plan_mode` tool joins the toolset — nothing else changes. A mode flip mid-session appends one coalesced `context/message` notice when the last header disagrees.

**Token effect**: Zero in the default mode. In plan mode, the section text plus one tool schema per request; every mode transition changes the logged header and therefore resets the provider prefix cache.

#### Plan-mode policy section

```markdown
You are in plan mode: a planning state. Explore, analyze, and design; reading files and running read-only commands is fine, but hold off on changes — edits and other side effects belong in the plan and run after its approval, not in this mode. When a decision or a missing detail blocks the plan, ask the user through the ask_user_question tool where it is available. A finished plan is delivered by calling exit_plan_mode — that call is what puts it in front of the user for review, so prefer it over pasting the plan as a plain reply or asking the user to switch modes themselves. If exit_plan_mode is unavailable or its review fails, ask the user to switch the session out of plan mode instead of pressing on.
```

### Exit review

**What the model sees**: The `exit_plan_mode` call carries the full plan markdown as its argument (retained in context as ordinary tool args); its result is one short confirmation or the reviewer's feedback verbatim.

**Token effect**: The plan text is paid once as tool args and stays in the conversation; a keep-planning round adds one feedback-sized result per revision.

## Known Limitations and Deferred Work

- **A mode restrains by guidance only** — nothing gates execution while a mode holds; a user who wants a hard floor pairs the mode with the independent sandbox/approval knobs. The [plan-mode RFC](../../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md) archives the two removed enforcement shapes (the interim allowlist, the `access` sandbox cap) and their restart trigger (effects self-declaration on tool definitions).
- **A pending flip set while idle dies with the process** — the UI re-applies; the idle-record primitive is the escape hatch if this bites.
- **Subagent mode inheritance is deferred** — a fork child inherits via the seeded prefix; a spawn child starts default unless its creator seeds `AgentOptions.mode`.

RFC: [plan mode](../../../docs/rfc/implemented/feature/2026-07-07-plan-mode.md).
