# @deepseek-ai/dsh-mode

Session modes are named, logged, per-agent collaboration states. **Plan mode** is the required first definition: the agent explores and designs under deployment-owned instructions, presents a reviewable plan, and crosses back through an explicit review. Modes are independent from enforcement knobs such as sandbox mode and approval policy.

## The mode state is a session event

`mode/set` (`{ mode: string }`) is a log-only, non-surface `SessionEventMap` member with whole-value-replace semantics; the pure `foldMode(events)` returns the last logged mode or `default`. Resume, fork, and compaction therefore restore the mode from the log, and UIs observe flips through `session/event`.

The `default` mode means no mode guidance. Loading this plugin still contributes one stable `exit_plan_mode` tool schema in every mode; that fixed schema is the cost that avoids changing the tool catalog at a mode boundary.

## What a mode carries

The plugin registers one `mode:policy` prompt section at order 50. It renders the active definition's deployment-configured `section` text and renders empty in `default`, for an agent-less assembly, or when a logged definition no longer exists.

A mode does not gate execution, filter tools, or change sandbox or approval settings. A deployment that wants a hard read-only floor while planning combines plan mode with the independent sandbox and approval controls. The config vocabulary is exactly `{ section }`; unknown keys fail at load.

## `ctx.modes`

`list()` returns `default` followed by the configured definitions. `get(agent)` returns the folded mode, treating a removed definition as `default`, plus any pending intent. `set(agent, mode)` validates against that vocabulary and records a pending intent. The service flushes the intent on `agent/prompt-submit` before the first assembly, `agent/turn-continuation` before a normal successor step, or after a composed `agent/request-error` decision authorizes a retry. Each append is turn-enclosed and precedes the affected prompt assembly, including an automatic recovery step after asynchronous backoff. A changed user selection adds one coalesced `context/message` notice when the last logged request header described a different mode; a net-zero selection sequence adds nothing.

There is no creation-time mode option: a UI (or a plugin) selects through `set()` before the first turn, and a fork child needs no mechanism at all — the parent's `mode/set` is inside the seeded prefix.

## Per-mode slash commands

When a command registry (`@deepseek-ai/dsh-commands`) is composed, each configured definition contributes its own entry command to interactive front doors. The required definition supplies `/plan`; a further `review` definition supplies `/review`. These commands accept no arguments, record the switch through `set()`, and report that it applies from the next turn. `default` is the absence of a definition and contributes no command. Without a commands service the child never mounts and nothing else changes.

Definition names must match `/^[a-z][a-z0-9_-]*$/u`, the shared mode/command subset; config fails at load before a definition can become selectable but undispatchable.

## `exit_plan_mode`

[`exit_plan_mode`](../../../docs/tool-catalog.md#deepseek-aidsh-mode) is registered in every mode so native tool schemas and Code Mode's generated SDK remain byte-identical across a mode switch. Its description says it is plan-only, and execution rechecks the folded mode and rejects outside `plan`.

In plan mode, the required `plan` argument makes the review artifact durable: native dispatch records it in `tool/call`; Code Mode records the outer `run_code` source before execution and the extracted arguments in `tool/code-dispatch` when the nested dispatch settles. The review request also carries the exact plan as supporting detail, so ACP and TUI show what is being approved even when Code Mode has no nested native call card. The tool asks the user to Approve or Keep planning through `ctx.userInteraction`, with optional free-text rejection feedback. Approval schedules a silent switch to `default` at the step boundary; every non-approval outcome returns a corrective `isError` and keeps plan mode. Native presentation additionally renders the markdown as a generic plan card.

## Config

The deployment must provide the complete plan-mode instructions in Cordis config; the package has no embedded plan prompt. See the [ACP example](../../../examples/acp-agent/cordis.yml) for the maintained production-shaped instructions.

```yaml
- id: mode
  name: '@deepseek-ai/dsh-mode'
  config:
    modes:
      plan:
        section: |
          You are in plan mode. Explore first, make no changes, and present a decision-complete plan through exit_plan_mode.
```

`resolveConfig` requires `modes.plan.section`, rejects `default` as a definition key, rejects invalid command-shaped names, blank sections, and unknown definition keys, and preserves any further named modes. `set()` rejects an unknown mode name.

## Model Experience

### Mode guidance section

#### What the model sees

In `default`, no `mode:policy` text appears. In a configured mode, that definition's exact `section` text appears after persona and before tool guidance. The package does not own a stable prompt literal; the [example Cordis config](../../../examples/acp-agent/cordis.yml) owns the plan instructions used by the shipped composition.

#### Token effect

`default` adds no section tokens. Plan mode adds the configured section on each request; the text is static until config or mode changes.

#### KV Cache effect

Within one mode, the section is stable. Entering or leaving a non-default mode changes the system prompt at order 50, so bytes from that section onward need a new cache path; the stable prefix before it can still be reused where the provider supports prefix caching. No tool-schema or Code Mode SDK churn accompanies the transition.

### Mode transition notices

#### What the model sees

A user-driven change whose previous request header described another mode appends either `The user switched this session to <mode> mode.` or `The user switched this session back to the default mode.` A logged mode removed from config reads as default without a notice. Initial selection before the first header, net-zero selections, and the tool-driven exit add no notice.

#### Token effect

Each qualifying transition adds one short conversation message once. The dynamic mode name is the only data-dependent part.

#### KV Cache effect

The notice itself is append-only conversation growth. A real mode transition also changes the earlier order-50 section, so that section remains the limiting cache boundary.

### Exit tool schema and review exchange

#### What the model sees

The [`exit_plan_mode` schema](../../../docs/tool-catalog.md#deepseek-aidsh-mode) is present in every mode. Outside plan mode, a call returns `Error: exit_plan_mode is only available in plan mode`. In plan mode, an empty or heading-less argument returns `Error: exit_plan_mode requires a non-empty markdown plan starting with a # heading` before review. A valid call carries the complete plan both as the tool argument and as review detail; exactly one `Approve` selection returns `Plan approved — plan mode exited; carry out the plan starting with your next step.`, while every other answer returns `Error: The user chose to keep planning; revise the plan and present it again.` or `Error: The user chose to keep planning; their feedback: <feedback>`. An unavailable review channel returns its fail-closed error and keeps the mode unchanged.

##### Stable literal

```markdown
Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. Send the COMPLETE plan as markdown, starting with a # heading that names it. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.
```

#### Token effect

The stable cost depends on ToolRegistry mode: `native` adds the tool schema, `code` adds the generated SDK binding inside the `run_code` surface instead of a native schema, and `both` adds both representations. The plan markdown is paid once as tool-call arguments and remains in context. Each rejection adds its feedback result, and the next revision adds another complete plan tool call.

#### KV Cache effect

The tool schema and generated SDK binding are byte-identical in `default`, `plan`, and custom modes, so a mode change adds no tool-catalog diff. The earlier order-50 section change still moves the cache path as described above; schema stability avoids a second source of request-shape churn and keeps subsequent requests within the new mode on one catalog shape. Loading or unloading the plugin itself changes that catalog. Review arguments and results extend the conversation normally.

## Known Limitations and Deferred Work

- A mode restrains by guidance only; pair it with independent enforcement knobs when a hard boundary is required. The [plan-mode Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md) records the rejected enforcement shapes and the effects-metadata restart trigger.
- A pending flip selected while idle is lost if the process exits before the next boundary; the UI must reapply it.
- Forked children inherit the logged mode, while spawned children start in `default`; there is no creation-time mode option.

Design: [plan-mode Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md).
