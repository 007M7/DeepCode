# @deepseek-ai/dsh-user-approval

Channel-neutral one-shot approval seam. `ctx.approval.request(req)` returns `allowed-once`, `rejected`, `cancelled`, or `unavailable`; missing or failing answerers fail closed, and a grant applies only to the requested action. Exact event signatures live in the generated [Cordis catalog](../../../docs/cordis-catalog/events.md).

Each request must belong to an open agent turn. The service appends a paired `approval/asked` and `approval/decided` audit record, while the model sees only the resulting logged tool outcome. An aborted request resolves `cancelled`; an audit append that fails before commit rejects rather than returning an unlogged decision.

Answerers are `approval/request` waterfall listeners. Return an outcome to answer for an owned agent or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests; compose one terminal answerer per deployment because sibling listener order is not a policy priority mechanism. The ACP bridge is the shipped human answerer.

`ApprovalPolicy` is `'ask'` or `'never'`. The effective value is the last `approval/policy` event, falling back to config; `setApprovalPolicy()` is the write path. `'never'` rejects before interactive dispatch and is the only policy stated in the prompt. Switches produce at most one coalesced notice, attributed to the user when the override follows the last `request/header` and to operator/config otherwise.

The tools pipeline routes `ask` decisions through this seam and fails closed when it is absent; the sandboxed bash tool also uses it for escalated retries. The ACP bridge is the shipped human answerer for calls it owns. Audit events remain log-only, so the model sees only the asking consumer's result. See the [approval-seam RFC](../../../docs/rfc/implemented/feature/2026-07-06-approval-seam.md) and [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).

## Model Experience

### System prompt and policy notice

**What the model sees**: Under `ask`, every agent request carries the ask-policy prompt section below. Under `never`, it carries the never-policy prompt section below. A policy switch injects exactly `The approval policy changed from "<old>" to "<new>" (changed by the user).` or `The approval policy changed from "<old>" to "<new>" (changed by the operator/config).` before the next step.

**Token effect**: Small fixed per-request cost, larger under `never`; a change notice is conditional and retained in history.

#### Ask-policy prompt section

```markdown
<!-- dsh-user-approval-policy:ask -->
```

#### Never-policy prompt section

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
<!-- dsh-user-approval-policy:never -->
```

### Tool outcome

**What the model sees**: `approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

**Token effect**: Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result.

## Known Limitations and Deferred Work

- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing; a durable out-of-turn approval workflow is deferred.
- **Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store; session policy is only `ask` / `never`.
- **The request carries no tool arguments** — a UI must correlate `callId` with an already rendered tool call, and a call-less request cannot be presented by the shipped ACP answerer.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.
