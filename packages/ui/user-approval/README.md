# @deepseek-ai/dsh-user-approval

English | [中文](README.zh.md)

Channel-neutral one-shot approval seam. `ctx.approval.request(req)` returns `allowed-once`, `rejected`, `cancelled`, or `unavailable`; missing or failing answerers fail closed, and a grant applies only to the requested action. Exact event signatures live in the generated [Cordis catalog](../../../docs/cordis-catalog/events.md).

Each request must belong to an open agent turn. The service appends a paired `approval/asked` and `approval/decided` audit record, while the model sees only the resulting logged tool outcome. An aborted request resolves `cancelled`; an audit append that fails before commit rejects rather than returning an unlogged decision.

Answerers are `approval/request` waterfall listeners. Return an outcome to answer for an owned agent or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests; compose one terminal answerer per deployment because sibling listener order is not a policy priority mechanism. The ACP automation bridge supplies one-shot machine decisions for sessions it owns.

`ApprovalPolicy` is `'ask'` or `'never'`. The effective value is the last `approval/policy` event, falling back to config; `setApprovalPolicy()` is the write path. `'never'` rejects before interactive dispatch and is the only policy stated in the prompt. Switches produce at most one coalesced notice, attributed to the user when the override follows the last `request/header` and to operator/config otherwise.

The tools pipeline routes `ask` decisions through this seam and fails closed when it is absent; the sandboxed bash tool also uses it for escalated retries. The ACP automation bridge answers calls for its own agents through the client's machine policy. Audit events remain log-only, so the model sees only the asking consumer's result. See the [approval-seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) and [sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

## Model Experience

### System prompt and policy notice

#### What the model sees

Under `ask`, every agent request carries the ask-policy prompt section below. Under `never`, it carries the never-policy prompt section below. A policy switch injects exactly `The approval policy changed from "<old>" to "<new>" (changed by the user).` or `The approval policy changed from "<old>" to "<new>" (changed by the operator/config).` before the next step.

##### Ask-policy prompt section

```markdown
<!-- dsh-user-approval-policy:ask -->
```

##### Never-policy prompt section

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
<!-- dsh-user-approval-policy:never -->
```

#### Token effect

Small fixed per-request cost, larger under `never`; a change notice is conditional and retained in history.

#### KV Cache effect

Prefix-stable while the approval policy is unchanged. An `ask`/`never` switch changes the system-prompt section and invalidates reuse from its first changed token; the accompanying notice is append-only.

### Tool outcome

#### What the model sees

`approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

#### Token effect

Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing; a durable out-of-turn approval workflow is deferred.
- **Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store; session policy is only `ask` / `never`.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.
