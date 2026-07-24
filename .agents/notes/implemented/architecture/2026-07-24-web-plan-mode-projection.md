# Agent Note: Project plan mode through the web host boundary

Status: implemented

English | [中文](2026-07-24-web-plan-mode-projection.zh.md)

## Problem

The plan service owned durable state and boundary timing, but the web host contract had no way to discover or select it. A browser could inspect the tail history page for `plan/mode`, yet that page may omit the latest relevant event after pagination or hold no event for the empty-log inactive state. It also cannot reveal a selection waiting for the next model-request boundary. A client-only toggle would therefore drift from resumed sessions, exit-tool transitions, and selections made by another surface.

The host does not mount plan mode for every product composition. The wire must distinguish an unavailable capability from a supported session whose committed state is inactive. Switching mode is also independent of cancelling an in-progress request: the existing service intentionally applies the latest selection at the next boundary.

## Decision

The session RPC domain exposes `session.planMode({ sessionId })` and `session.setPlanMode({ sessionId, active })`. Their shared value is `null | { active: boolean, pending?: boolean }`. `null` means the optional `ctx.planMode` service is absent; `{ active: false }` means the service is available and inactive. Both methods resume a cold session through the same host-owned path as history and prompt before reading or changing state.

The host adapter delegates selection and folding to `ctx.planMode`; it does not append events or duplicate boundary logic. `active` is the last committed logged value. When present, `pending` is the selected target value awaiting a model-request boundary; its presence, rather than its boolean value, identifies pending intent. Re-selecting the committed value can therefore return `pending: false` while cancelling a pending entry. The boundary then removes that intent without logging a redundant state event. The RPC does not cancel a running request, so a selection made during generation leaves that request unchanged and shapes the next one.

The browser session object queries the complete state after history opens and on reconnect. A failed plan query is fail-soft: history remains usable and the last known capability state is retained. A reconnect generation fence prevents a superseded query from overwriting the newer result. A separate local event-version fence prevents a query or selection response from overwriting a `plan/mode` commit that overtook it on the mux stream; an early commit remains private until a successful query confirms capability presence. Successful selections otherwise update the snapshot only from the host-confirmed response, while business and transport failures leave the prior state intact.

Committed `plan/mode` session events remain the live notification. When the host advertised the capability, a valid event replaces `active` and clears `pending`. The object layer ignores malformed events and does not infer capability from a raw event alone. This keeps full-state reads authoritative while preserving the existing logged event stream as the commit signal.

## State and timing

| Starting state | Selection | Immediate RPC state | Next request boundary |
|---|---|---|---|
| Inactive | Plan | `{ active: false, pending: true }` | Logs `plan/mode: true`; snapshot becomes active |
| Active | Default | `{ active: true, pending: false }` | Logs `plan/mode: false`; snapshot becomes inactive |
| Inactive with pending Plan | Default | `{ active: false, pending: false }` | No state event is needed |
| Capability absent | Either | `null` | No plan behavior is introduced |

Stopping generation remains a separate session operation. A pending selection survives cancellation and applies when the next prompt or continuation reaches the service boundary.

## Alternatives considered

**Fold only the currently loaded history page.** Rejected because message-boundary pagination can omit the latest mode event, and a page cannot represent pending intent or distinguish empty-log inactive from capability absence.

**Keep an optimistic browser boolean.** Rejected because tool-approved exit, another client, resume, and append failure can all disagree with the speculative value. The browser displays only the state returned by the owner.

**Add a dedicated plan control frame.** Rejected because committed state already has the logged `plan/mode` event. A full-state unary query covers open and reconnect without adding a second live event vocabulary.

**Expose generic named collaboration modes.** Rejected by the plan-specific state decision: ACP may keep a generic adapter vocabulary, but the product currently owns one concrete boolean domain.

## Verification

- API schemas reject invalid request and state shapes, and both fetch directions dispatch the two methods.
- Host runtime tests cover capability absence, real-service pending and cancellation state, cold-session errors, and shared RPC semantics.
- Client object tests cover open, selection success, business and transport failure, committed live events, malformed and unavailable events, fail-soft queries, reconnect refresh, superseded-query fencing, and mux commits overtaking unary responses.

## Consequences

Web UI packages can discover plan mode without importing its host implementation and can display boundary-pending state without duplicating the plan service. Other clients may use the same optional projection. The contract deliberately does not combine switching with stop, invent generic mode identifiers, or make plan capability mandatory for every host composition.
