# @deepseek-ai/dsh-command-goal

Human-facing `/goal` control over [`ctx.goals`](../goal/README.md). The plugin registers one global command through [`ctx.commands`](../../ui/commands/README.md), so every composed command adapter discovers it; the shipped TUI and ACP execute it without a model turn. The [human goal-command Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-human-goal-command.md) owns the UX and composition decisions.

## Command contract

| Input | Result |
|---|---|
| `/goal` | Show the current objective, durable phase, round count/cap, process-local activation, and valid next commands; a blocked goal also shows its policy code and explanation, while no goal shows usage. |
| `/goal <objective>` | Create and arm a goal, or replace a completed goal with a fresh identity. An unfinished goal is never replaced without an explicit clear. |
| `/goal edit <objective>` | Edit the current objective without changing its phase or activation. Editing a completed goal creates a fresh active goal. |
| `/goal pause` | Pause an active goal and disarm continuation. |
| `/goal resume` | Resume a stopped goal or rearm an active goal after session resume/fork, subject to its remaining round cap. |
| `/goal clear` | Clear the current pointer while retaining its durable history and tombstone. |

Control words are case-insensitive only when they occupy the complete input. Every other non-empty suffix is an objective, so `/goal pause after verification` creates that literal objective. The goal domain trims and validates objectives. Because the generic command plane has no modal editor or confirmation primitive, `edit` takes its replacement inline and an unfinished replacement returns a direct error instructing the user to edit or clear.

Expected domain rejections become stable direct command errors without exposing branded ids or revisions. Unexpected implementation failures still reject dispatch so adapters can report them as command failures. Generic command text and output remain live UI state; every accepted mutation is persisted and made model-visible by `dsh-goal` rather than by this plugin.

## Composition

The producer injects `commands` and `goals`. A custom app mounts their owners plus this plugin; automatic continuation remains an independent choice:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: command-goal
  name: '@deepseek-ai/dsh-command-goal'
```

The TUI and ACP demo apps enable the complete persisted-goal stack and this command by default; `goals: false` removes both. The UI-less `agent-spine-demo` requires an explicit `goals: {}` so headless one-shot callers do not silently change from one physical turn to a multi-round operation.

## Model Experience

### Human `/goal` control

#### What the model sees

The slash input and direct status/error output are absent from model requests. An accepted mutation later appears through the goal domain's raw `<goal_state>` snapshot or clear tombstone; this preserves the model-visible-is-logged invariant without logging presentation text.

#### Token effect

Reading status or receiving a direct command error adds no model tokens. Each accepted mutation adds the goal domain's retained full snapshot, and an enabled same-session driver may add later goal-round prompts.

#### KV Cache effect

Command discovery and direct output do not affect the cache. A mutation appends after the reusable history prefix; later compaction may replace the derived-history suffix.

## Known Limitations and Deferred Work

- **Plain-text interaction only** — the generic command registry has no modal edit form or replacement-confirmation callback; inline edit and explicit clear keep destructive intent deterministic on both TUI and ACP.
- **No per-command round-cap argument** — `defaultMaxGoalRounds` remains deployment config, while a direct human request may ask the model to edit `max_goal_rounds` through the separately authorized goal tool.
- **No continuous status widget** — bare `/goal` is the portable observation surface; adapter-specific badges and reconnectable command output remain future UI work.
- **TUI and ACP only** — the headless CLI and JSON-RPC adapters do not consume `ctx.commands`. Ordinary human prompts can still authorize the model-facing goal tools when those are composed.
