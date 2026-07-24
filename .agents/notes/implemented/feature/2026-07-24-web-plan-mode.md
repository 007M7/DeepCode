# Agent Note: Compose plan mode into the Web product

Status: implemented

English | [中文](2026-07-24-web-plan-mode.zh.md)

## Problem

The Web host can project plan state through the [optional session RPC contract](../architecture/2026-07-24-web-plan-mode-projection.md), but the shipped Web product did not mount the plan service or expose a mode control. Mounting only a browser toggle would leave the model without plan guidance and `exit_plan_mode`; mounting only the host service would make the feature undiscoverable and hide state waiting for the next request boundary.

Plan selection is not a stop command. The plan service deliberately queues the latest target for a model-request boundary so the current request remains internally consistent. The UI must show both the committed state and that pending target, including `pending: false`, without speculating past the host response. The model-driven exit also needs the existing structured plan review rather than a second Web-only approval path.

## Decision

`@deepseek-ai/dsh-client-ui-plan` is one Web feature plugin with lifecycle-coupled host and browser entries. Its host entry mounts `@deepseek-ai/dsh-plan-mode` with the Web product's complete planning policy. Its browser entry registers `PlanModeControl` into the session-scoped `conversation.composer.controls` list slot. The `dsh web` roster selects the package once; plugin discovery loads the browser entry while the same roster mount supplies the host behavior.

The policy is product-owned configuration at this composition boundary. It tells the model to inspect before planning, avoid mutation while planning, resolve discoverable facts without asking, make the plan decision-complete, and submit it as the only final `exit_plan_mode` call. The plan package continues to own logged state, boundary timing, prompt-section activation, the stable exit-tool schema, and review semantics. The Web plugin does not copy any of those mechanisms.

`ui-conversation` owns and renders the new additive controls slot to the left of the primary composer action. It provides no business payload; entries receive the standard session kit. Whole-composer replacements remain on the separate selector-routed `conversation.composer` chain, so a pending question replaces the InputBar and its controls without either feature importing the other.

The control is absent when `planMode` is `null`. Otherwise, its selected value is `pending ?? active`, while pending presentation tests field presence rather than truthiness. It displays `计划 · 待生效` or `默认 · 待生效` until a logged commit replaces the snapshot. The transparent native select mirrors focus onto the visible chip and references a dynamic accessible description that distinguishes committed mode from the pending target. A selection disables only the selector while its own RPC is in flight. Generation does not disable it: selecting during a running turn neither calls cancel nor changes that turn, and cancelling generation does not clear the pending target.

## Interaction semantics

| Observed state | Control | User action | Result |
|---|---|---|---|
| `{ active: false }` | Default | Select Plan | Host confirms `{ active: false, pending: true }` |
| `{ active: false, pending: true }` | Plan, pending | Send a prompt | Boundary logs `plan/mode: true`; control becomes committed Plan |
| `{ active: true }`, running | Plan | Select Default | Turn continues; control shows Default pending |
| `{ active: true, pending: false }` | Default, pending | Stop | Pending target survives; the next prompt commits Default |
| `null` | Hidden | — | Composition exposes no unsupported control |

Business and transport failures leave the confirmed snapshot unchanged, re-enable the selector, and render a compact visible failure beside it. The component guards asynchronous completion after unmount so switching sessions cannot update a retired control.

Sending waits for the latest selector request and any newer selection that supersedes it. During that admission-only interval, the composer clears its draft and disables duplicate sends; it does not wait for model generation. Host acceptance releases the admission lock, after which the ordinary running state keeps Stop available. A selection or admission failure sends no prompt and restores the submitted draft only when replacement text has not appeared.

## Exit review

`exit_plan_mode` remains registered in both modes for request-cache stability. In plan mode the model submits the complete Markdown plan through that tool. The plan service asks through `ctx.userInteraction`, and the already-composed Web question plugin presents the plan detail with Approve, Keep planning, and the free-text answer channel. Question detail reuses the assistant-output Markdown primitive and its untrusted-content policy. The capped question card keeps its title, navigation, and submission actions fixed while the complete plan and choices share an internal scroll region. The chat flow omits its generic pending-question placeholder because the composer takeover is the sole presentation of that wait.

Approval queues inactive mode for the next step; it does not rewrite the current tool batch. Keep planning or custom feedback leaves plan mode active and returns corrective feedback to the model. If the review channel is unavailable or aborted, the tool fails closed and the policy tells the model to ask the user to switch modes manually.

## Product composition and evidence

Fixture mode implements the same pending and boundary behavior in memory so browser acceptance tests exercise the assembled product without a key. The keyless browser flow selects Plan, commits it with a prompt, selects Default during generation, stops without losing the pending target, and commits Default with the next prompt. A file snapshot records each user-visible state. A real `dsh web` process with a mock provider additionally proves that the roster mounts plan mode, the state RPC reports capability, and the active Web policy reaches the provider request alongside workspace instructions.

## Alternatives considered

**Put the selector directly in `ui-conversation`.** Rejected because the conversation skeleton would acquire plan-domain knowledge and a host dependency. The additive slot keeps feature ownership in `ui-plan` and leaves room for independent controls.

**Mount plan mode unconditionally in the host runtime.** Rejected because plan mode is a product composition choice. The optional RPC contract must continue to represent hosts that do not select it.

**Optimistically flip a local boolean.** Rejected because a host append failure, another surface, resume, or tool-reviewed exit can disagree. The control displays only host-confirmed committed and pending state.

**Disable switching while generation runs or make switching stop the turn.** Rejected because it changes the plan service's boundary contract and couples collaboration state to cancellation. The pending state exists specifically to keep those operations independent.

**Create a Web-specific plan approval component.** Rejected because plan review is already a structured user-interaction question. Reusing the question composer preserves one review protocol and the free-text correction path.

## Consequences

The Web product now exposes the same plan interaction model as the current terminal and ACP compositions while retaining its plugin boundaries. Selecting the feature adds one host policy/tool owner and one browser slot entry; removing its fiber removes both. The model tool catalog stays stable across mode changes, but the active system-prompt section changes at a plan boundary and therefore changes the request prefix. Plan mode remains guidance, not an execution sandbox: deployments that require enforced read-only planning still compose the independent sandbox and approval policies.
