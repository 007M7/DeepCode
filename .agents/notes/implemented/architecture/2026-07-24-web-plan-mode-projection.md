# Agent Note: Project plan mode through the web host boundary

Status: implemented

English | [中文](2026-07-24-web-plan-mode-projection.zh.md)

## Problem

The plan service owned durable state and boundary timing, but the web host contract had no way to discover or select it. A browser could inspect the tail history page for `plan/mode`, yet that page may omit the latest relevant event after pagination or hold no event for the empty-log inactive state. It also cannot reveal a selection waiting for the next model-request boundary. A client-only toggle would therefore drift from resumed sessions, exit-tool transitions, and selections made by another surface.

The host does not mount plan mode for every product composition. The wire must distinguish an unavailable capability from a supported session whose committed state is inactive. Switching mode is also independent of cancelling an in-progress request: the existing service intentionally applies the latest selection at the next boundary.

## Decision

The session RPC domain exposes `session.planMode({ sessionId })` and `session.setPlanMode({ sessionId, active })`. Their shared value is `null | { active: boolean, pending?: boolean }`. `null` means the optional `ctx.planMode` service is absent; `{ active: false }` means the service is available and inactive. Both methods resume a cold session through the same host-owned path as history and prompt before reading or changing state. `session.prompt` additionally accepts an optional `planMode` target, letting a client bind the selected target to the prompt it submits.

The host adapter delegates selection and folding to `ctx.planMode`; it does not append events or duplicate boundary logic. `active` is the last committed logged value. When present, `pending` is the selected target value awaiting a model-request boundary and differs from `active`; its presence, rather than its boolean value, identifies a user-visible pending transition. Re-selecting the committed value can leave an internal cleanup intent in the service, but the adapter canonicalizes that net-zero state to `{ active }`. The boundary then removes the intent without logging a redundant state event. The wire schema rejects equal `active` and `pending` values. The RPC does not cancel a running request, so a selection made during generation leaves that request unchanged and shapes the next one.

The browser session object queries the complete state after history opens and on reconnect. A failed plan query is fail-soft: history remains usable and the last known capability state is retained. A reconnect generation fence prevents a superseded open from overwriting the newer result. One monotonic plan-request fence covers both queries and selections, so an older unary response cannot replace the result of a newer request. A separate local event-version fence prevents a current query or selection response from overwriting a `plan/mode` commit that overtook it on the mux stream; an early commit remains private until a successful query confirms capability presence. Successful selections otherwise update the snapshot only from the host-confirmed response, while business and transport failures leave the prior state intact.

Prompt admission waits for the latest selector request and follows any newer overlapping selection that supersedes the one it was awaiting. The latest outcome is retained after settlement so an already-completed failure cannot be missed. That failure rejects the prompt locally, letting the composer restore its draft instead of sending under an uncertain mode. After selection succeeds, the browser attaches the confirmed `pending ?? active` target to `session.prompt`. The host applies that target immediately before the synchronous `send` or `steer` admission, with no await where another request could interleave; unavailable plan capability fails closed, and a synchronous admission rejection restores the preceding target. Model generation begins only after admission and remains independently cancellable.

Committed `plan/mode` session events remain the live notification. When the host advertised the capability, a valid event replaces `active` and clears `pending`. Both the append path and a history replacement window observe the newest valid plan event by sequence, so gap repair applies a recovered commit even when the buffered triggering frame becomes replay overlap. The object layer ignores malformed events and does not infer capability from a raw event alone. This keeps full-state reads authoritative while preserving the existing logged event stream as the commit signal.

## State and timing

| Starting state | Selection | Immediate RPC state | Next request boundary |
|---|---|---|---|
| Inactive | Plan | `{ active: false, pending: true }` | Logs `plan/mode: true`; snapshot becomes active |
| Active | Default | `{ active: true, pending: false }` | Logs `plan/mode: false`; snapshot becomes inactive |
| Inactive with pending Plan | Default | `{ active: false }` | No state event is needed |
| Capability absent | Either | `null` | No plan behavior is introduced |

Stopping generation remains a separate session operation. A pending selection survives cancellation and applies when the next prompt or continuation reaches the service boundary.

## Alternatives considered

**Fold only the currently loaded history page.** Rejected because message-boundary pagination can omit the latest mode event, and a page cannot represent pending intent or distinguish empty-log inactive from capability absence.

**Keep an optimistic browser boolean.** Rejected because tool-approved exit, another client, resume, and append failure can all disagree with the speculative value. The browser displays only the state returned by the owner.

**Add a dedicated plan control frame.** Rejected because committed state already has the logged `plan/mode` event. A full-state unary query covers open and reconnect without adding a second live event vocabulary.

**Expose generic named collaboration modes.** Rejected by the plan-specific state decision: ACP may keep a generic adapter vocabulary, but the product currently owns one concrete boolean domain.

## Verification

- API schemas reject invalid request and state shapes, including equal committed and pending values, and both fetch directions dispatch the two methods.
- Host runtime tests cover capability absence, real-service pending state, canonical net-zero cancellation, cold-session errors, atomic prompt admission, admission rollback, and shared RPC semantics.
- Client object tests cover open, selection success, prompt waiting and failure containment, overlapping selection response order, business and transport failure, committed live events, gap-repaired commits, malformed and unavailable events, fail-soft queries, reconnect refresh, superseded-query fencing, and mux commits overtaking unary responses.

## Consequences

Web UI packages can discover plan mode without importing its host implementation, display boundary-pending state without duplicating the plan service, and bind one submitted prompt to the selected target. Other clients may use the same optional projection. The contract deliberately does not combine switching with stop, invent generic mode identifiers, or make plan capability mandatory for every host composition.
