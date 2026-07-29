# @deepseek-ai/dsh-client-ui-plan

English | [中文](README.zh.md)

Plan-mode status chip, a pure browser surface plugin. The browser half occupies the conversation-declared `conversation.input.plan` single seat (to the right of the access-mode control); the node half is an empty apply (the roster row). Plan behavior itself — the `/plan` command, the boundary-or-idle-committed `plan/mode` state, the `plan` projection unit, and the policy section — is owned by [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.md), composed independently on the host roster.

Plan mode is entered through the `/plan` command only; there is no UI control that turns it on. While the host-computed `plan` projection's effective target is plan mode (`pending ? !active : active` — a folded host value, not client optimism, so an arriving frame corrects the chip either way), the seat renders a read-only "Plan" chip whose hover × executes `/plan off` through `command.execute`; otherwise the seat stays empty — a host without plan-mode (or a Draft with no session) shows nothing. While plan mode is the effective target, the composer textarea's placeholder switches to "describe your task to generate plan" (rendered by the composer from the same projection; owner-supplied placeholders win).

The chip carries the accessible description "Plan mode on, press to turn off". Admission failures (`matched: false`, business errors, transport faults) surface as an inline error and the chip stays until the projection confirms the exit.

The model exits plan mode through the stable `exit_plan_mode` tool; its plan review uses the composed Web question channel.

## Model Experience

Indirectly, through the `/plan off` command line the chip dispatches: `@deepseek-ai/dsh-plan-mode` owns the model-visible policy section, the exit-tool schema, and the logged state that line drives, while this package only renders the projection and sends what a user could equally type.

#### KV Cache effect

Entering or leaving plan mode changes the active `plan:policy` system-prompt section and therefore the request prefix; the chip itself adds no prompt content.

## Known Limitations and Deferred Work

- **Plan mode is guidance, not an execution sandbox** — deployments that require enforced read-only planning must compose the independent sandbox and approval policies.
- **The chip belongs to the default composer** — a pending whole-composer interaction such as plan review temporarily replaces the InputBar and its chip.
- **No UI entry point** — plan mode is entered by typing `/plan`; a session with the capability but inactive mode shows no affordance in the tool row.
