# RFC: Agent lifecycle and ownership seams

Status: proposed

## Problem

Several ACP and tool-bash limitations are symptoms of the same missing seam: plugins can create or resume agents through `ctx.agents`, but they cannot own and dispose one agent independently, and long-running bash tasks carry no stable owner in the executor itself. ACP currently aborts and awaits agents on disconnect, but cannot unregister just that session's agent; `session/cancel` cannot cancel queued-but-not-yet-started work; and `tool-bash` keeps task ownership in a plugin-local `Map`, so an HMR reload can make an old task look unowned.

## Proposal

Add explicit lifecycle ownership to the agent factory and explicit ownership metadata to background tasks.

1. `ctx.agents.create/resume` should return an `AgentHandle` (or add an adjacent method) that exposes the `Agent` plus an async disposer. The disposer unregisters the agent, aborts queued/running work, and resolves only when the driver loop reaches quiescence.
2. Add a queue-aware cancel primitive to the `Agent` interface. It must clear queued work that has not started, abort the current step if one exists, and make `whenIdle()` wait for the post-cancel quiescent state. ACP `session/cancel` and bridge teardown then become honest cancellation, not best-effort pre-step cancellation.
3. Move background task ownership into the bash seam. `BashExecSpec` or `BashTask` should carry a stable owner token, preferably the session id rather than the `Agent` object identity. `bash_output`/`bash_kill` then ask the executor for ownership rather than relying on a `tool-bash` instance-local map.

## Acceptance Criteria

- ACP disconnect/session close leaves no registered agent for that session, even when `session/load` races teardown.
- `session/cancel` before a queued prompt starts prevents that prompt from running and cannot batch the next prompt into the cancelled turn.
- A `tool-bash` HMR reload does not make an existing background task readable or killable by a different session.
- Existing non-ACP demos still work without managing handles explicitly; config-created agents remain owned by the `AgentLoop` plugin fiber.

## Risks

This touches public interfaces (`Agent`, `AgentFactory`, and the bash seam), so it should not be smuggled into a local ACP patch. The compatibility trap is preserving the simple synchronous `Agent.send()` ergonomics while adding a robust async lifecycle path for owners that need it.
