# @deepseek-ai/dsh-client-ui-plan

Web plan-mode feature with two lifecycle-coupled halves. The node entry mounts `@deepseek-ai/dsh-plan-mode` with the Web product policy; the browser entry contributes a session-scoped selector to `conversation.composer.controls`.

The selector distinguishes unavailable capability (`planMode === null`), committed mode (`active`), and the target queued for the next model-request boundary (`pending`, including `pending: false`). Selecting a mode never cancels a running turn. It remains available while generation is running, disables only during its own RPC, and displays the host-confirmed pending target until a logged `plan/mode` event commits it. The transparent native select mirrors keyboard focus onto the visible chip and carries a dynamic accessible description of the committed and pending modes.

The model exits plan mode through the stable `exit_plan_mode` tool. Its plan review uses the composed Web question channel: approval schedules default mode for the next step, while rejection or custom feedback keeps plan mode active and returns the feedback to the model.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-plan-mode`; that package owns policy activation, the exit-tool schema and rendering, logged state, and request-boundary transitions, while this package supplies the Web composition's section text.

#### KV Cache effect

Entering or leaving plan mode changes the active system-prompt section and therefore the request prefix. The stable exit-tool registration avoids an additional tool-catalog shape change across the same transition.

## Known Limitations and Deferred Work

- **Plan mode is guidance, not an execution sandbox** — deployments that require enforced read-only planning must compose the independent sandbox and approval policies.
- **The control belongs to the default composer** — a pending whole-composer interaction such as plan review temporarily replaces the InputBar and its mode control.
- **An idle pending target is process-local until the next boundary** — a process exit before another prompt loses that uncommitted intent; the committed mode remains durable in the session log.
