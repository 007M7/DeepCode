# @deepseek-ai/dsh-client-ui-plan

Plan-mode composer control, a pure browser surface plugin. The browser half occupies the conversation-declared `conversation.input.plan` single seat with a pending-aware mode selector; the node half is an empty apply (the roster row). Plan behavior itself — the `/plan` command, the boundary-committed `plan/mode` state, the `plan` projection unit, and the policy section — is owned by [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.md), composed independently on the host roster.

Reads ride the generic projection pair: the control renders the host-computed `plan` projection (`{ active, pending }`) through the standard-kit `useProjection`; an absent key is capability absence and hides the control, so a host without plan-mode (or a Draft with no session) shows no seat content. Writes ride the standard command channel: selecting a mode executes `/plan` or `/plan off` through `command.execute`, whose logged `command/run` immediately folds into a pending projection frame and whose request-boundary `plan/mode` commit resolves it — the control never holds client-side plan state, displays only host-confirmed values, and stays available while generation runs (switching never cancels a turn; the pending target applies at the next model-request boundary).

The transparent native select mirrors keyboard focus onto the visible chip and carries a dynamic accessible description of the committed and pending modes. Admission failures (`matched: false`, business errors, transport faults) surface as an inline error without mutating the displayed mode.

The model exits plan mode through the stable `exit_plan_mode` tool; its plan review uses the composed Web question channel.

## Model Experience

None directly. Model-visible plan behavior (policy activation, the exit-tool schema, logged state) is owned by `@deepseek-ai/dsh-plan-mode`; this package only renders the projection and dispatches `/plan` lines a user could equally type.

## Known Limitations and Deferred Work

- **Plan mode is guidance, not an execution sandbox** — deployments that require enforced read-only planning must compose the independent sandbox and approval policies.
- **The control belongs to the default composer** — a pending whole-composer interaction such as plan review temporarily replaces the InputBar and its mode control.
- **No Draft-time selection** — before a session exists there is no projection and the seat stays empty; plan mode is selected after the first prompt creates the session.
