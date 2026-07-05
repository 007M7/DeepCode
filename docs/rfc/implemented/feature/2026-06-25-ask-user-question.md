# RFC: Ask-user question capability

Status: implemented

## Problem

The agent sometimes cannot proceed safely from model inference alone: it needs the human to choose a path, confirm a risky/default action, or provide missing information. Before this change, the only way to get that answer was for the model to ask in assistant text and then stop, which broke the normal tool-call loop: the agent had no structured way to pause, no option metadata for UIs, no abort/error taxonomy, and no way for non-stdio front doors to present the question consistently.

This is a user-facing capability, but it also crosses package boundaries. A model-facing tool needs a provider-neutral request vocabulary; each UI surface needs to decide how to show and collect the answer; the agent loop should remain unchanged because a tool call already has the right async shape.

## Decision

Introduce `dsh-user-interaction` as the core interface package for `ctx.userInteraction`, and keep the model-facing consumer `dsh-tool-ask-user` under `packages/ui/tool-ask-user` rather than the core spine. The split is intentional: core owns the abstract seam and stable request/answer/error vocabulary; UI product surfaces own the affordance that asks a human and the concrete provider that collects the answer. The tool registers `ask_user_question`, forwards `{ question, header, options, allowCustom, agent, signal }`, and returns the provider-computed `answer` as the tool result.

The request vocabulary supports a short `header`, the required `question`, optional mutually exclusive `options`, `description` for each option, a `recommended` marker, and `allowCustom`. `label` is user-facing display text; `value` is the model-facing answer for a selected option and defaults to `label`. Providers return `AskUserQuestionAnswer.answer` as the single source of truth; the selected `option` is metadata. The tool schema exposes `description` only, not the synonym `desc`, to keep the model-facing surface small.

Optionless questions are always free-form, even if a caller passes `allowCustom: false`. The opposite would create an unanswerable prompt: with no option to select and free-form input disallowed, every human answer would be rejected forever. Providers therefore treat "no options" as the free-form shape.

`UserInteractionError` extends `HarnessError`, so failures such as `NO_PROVIDER`, `ASK_ABORTED`, ACP cancellation, or missing session routing survive `ctx.tools.execute()` as machine-routable `{ name, code }` tool errors. This matches the structured-error taxonomy and lets the model or a wrapping plugin distinguish "user cancelled" from a generic thrown exception.

## UI mappings

`dsh-stdio-agent`'s in-package readline module renders the question, sorts recommended options first, shows each option's `description` on the next line, accepts the recommended option on an empty answer, and rejects pending questions on abort, provider disposal, or stdin EOF. The stdio provider serializes multiple simultaneous questions with an internal queue so only one prompt owns stdin at a time.

`dsh-acp` provides the same seam for ACP sessions. It routes an ask request from the calling `Agent` through the bridge's `agent→sessionId` reverse map and calls ACP `unstable_createElicitation` with a session-scoped form. Option choices become a `choice` single-select field with the recommended option as the schema default; free-form answers use `answer` for optionless questions and `custom_answer` when options plus custom input are allowed. ACP `decline`/`cancel`, a missing answer, a missing session, and a client without elicitation support all become structured `UserInteractionError`s.

The ACP mapping deliberately uses elicitation, not `session/request_permission`. `request_permission` is still reserved for the separate permission gate: it is a yes/no-or-policy authorization protocol around tool execution. `ask_user_question` is a general information-gathering tool with optional free-form answers, so ACP form elicitation is the closer protocol fit. The bridge's session routing is shared with the future permission gate, but the user intent is different.

## Risks / trade-offs

ACP elicitation is currently marked unstable in the SDK. The fallback is still structured: if a client does not implement it, the tool returns `ASK_FAILED` rather than hanging. A later ACP stabilization may rename or reshape the method; that migration should stay inside `dsh-acp` because the core `ctx.userInteraction` vocabulary is provider-neutral.

The feature gives the model a powerful pause primitive, so prompt guidance matters. The tool description tells the model to ask concise questions and use options when possible. Product policy can later wrap `tools/execute` to restrict when the tool is allowed, but the loop should not special-case it.

`dsh-tool-ask-user` lives in `packages/ui` even though it is a tool, because it is a product-facing human-interaction affordance rather than providerless loop infrastructure. The core package remains only the abstract seam; `agent-core` does not load the tool. Front-door app packages such as `stdio-agent` and `acp-agent` opt into it alongside their UI provider.

## Test plan

Unit coverage pins provider registration/disposal, duplicate-provider rejection, abort-before-provider, structured tool errors through `ctx.tools.execute()`, option labels/values, and the model schema including the removal of `desc`. `dsh-stdio-agent` tests cover recommended-first display, descriptions, queued questions, EOF/abort cleanup, and optionless free-form input even with `allowCustom: false`. ACP bridge tests drive a real in-memory ACP connection with the real `ask_user_question` tool and verify both selected-option and optionless free-form elicitation paths continue the agent loop.
