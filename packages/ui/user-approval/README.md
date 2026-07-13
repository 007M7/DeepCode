# @deepseek-ai/dsh-user-approval

Channel-neutral one-shot approval seam. `ctx.approval.request(req)` returns `allowed-once`, `rejected`, `cancelled`, or `unavailable`; missing or failing answerers fail closed, and a grant applies only to the requested action. Exact event signatures live in the generated [Cordis catalog](../../../docs/cordis-catalog/events.md).

Each request must belong to an open agent turn. The service appends a paired `approval/asked` and `approval/decided` audit record, while the model sees only the resulting logged tool outcome. An aborted request resolves `cancelled`; an audit append that fails before commit rejects rather than returning an unlogged decision.

Answerers are `approval/request` waterfall listeners. Return an outcome to answer for an owned agent or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests; compose one terminal answerer per deployment because sibling listener order is not a policy priority mechanism. The ACP bridge is the shipped human answerer.

`ApprovalPolicy` is `'ask'` or `'never'`. The effective value is the last `approval/policy` event, falling back to config; `setApprovalPolicy()` is the write path. `'never'` rejects before interactive dispatch and is exposed to the model through the prompt and a coalesced switch notice.

The tools pipeline consumes this seam for `ask` decisions and the sandboxed bash tool uses it for escalated retries. See the [approval-seam RFC](../../../docs/rfc/implemented/feature/2026-07-06-approval-seam.md) and [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).
