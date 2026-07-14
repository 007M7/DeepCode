# @deepseek-ai/dsh-user-approval

User-approval seam. Owns the `ctx.approval` service ([`ApprovalService`](src/index.ts)) and the one-shot permission vocabulary the harness shares: `ApprovalRequest` (agent + tool identity + reason + abort signal), the closed `ApprovalOutcome` union (`allowed-once` / `rejected` / `cancelled` / `unavailable`), the `ApprovalRequestId` brand pairing the two log-only audit events (`approval/asked` / `approval/decided`), and the `approval/request` waterfall the answerers listen on. It lives in the UI group because its purpose is human permission, while remaining channel-neutral: it depends only on Cordis and core vocabulary packages, never on a concrete UI.

The contract in one line: `ctx.approval.request(req)` puts exactly one question — "may this specific action proceed?" — to whatever answerers the deployment composed, and its answerer phase always produces an outcome: an aborted signal yields `cancelled`, a throwing or missing answerer yields `unavailable`, and `allowed-once` is a grant for the single asked-about action, never a class of future ones. `ApprovalRequest` is a readonly same-process contract: the service borrows the exact request, agent, session, and abort signal rather than cloning or freezing them. The request requires an open turn because the audit pair is turn-enclosed by contract (the turn is the durable log's commit/replay boundary; a bare event between turns is crash-tail garbage on reload), so an idle ask rejects before appending. Either audit append may reject before commit because returning an unlogged decision would violate the pair. Session contains post-commit observer failures, so an authoritative audit append cannot reject the request or suppress its matching event.

The service is the mechanism, answerers are the policy. Answerers are `approval/request` waterfall listeners occupying a single decision slot: answer for an agent you own by returning an outcome without calling `next()`, or delegate an agent you don't recognize by calling `next()` — the chain's built-in default is `unavailable`, so a deployment with no answerer (headless, CI) fails closed with zero configuration. Dispatch is keyed by `req.agent`: a listener registered through `agent.ctx` receives only that agent's questions, while a plain-context listener receives every agent's. Registration order across sibling plugins is not load-order deterministic; compose one terminal answerer per deployment and use `prepend` listeners only for decide-or-delegate gates.

The seam also owns the per-session POLICY tier ([the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): `ApprovalPolicy` is `'ask'` (delegate to the answerers) or `'never'` (deterministically reject without prompting anyone; the strict CI/unattended stance), with `effective = fold(the session's 'approval/policy' events, last one wins) ?? Config.policy` — the session log is the store, written only through `setApprovalPolicy(session, policy)`, which rejects any value outside that closed vocabulary before appending. The service decides `'never'` inside `request()` itself, before dispatching the waterfall (`'never'` → `'rejected'` with the audit pair still landing; no listener registration, including a later `prepend`, can precede it), states `'never'` — and only `'never'` in prose — in a per-agent prompt section, records either value with a source-owned header marker, and narrates a policy switch to the model in at most one coalesced `agent/pre-step` notice. The restart fallback reads the marker rather than deployment-controlled persona prose; attribution is positional (an override event after the last `request/header*` reads `changed by the user`, otherwise `changed by the operator/config`).

One seam serves both ask paths of [the sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md): the `tools/pre-execute` `ask` decision (routed by [`@deepseek-ai/dsh-tools`](../../core/tools/) when this service is mounted; degrading to deny when it is not), and the sandbox post-denial escalated retry (the bash tool's `sandbox_permissions` gate in [`@deepseek-ai/dsh-tool-bash`](../../bash/tool-bash/) — [the sandbox RFC § Escalation](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)). The full design: [the approval-seam RFC](../../../docs/rfc/implemented/feature/2026-07-06-approval-seam.md).

Answerers today: the ACP bridge ([`@deepseek-ai/dsh-acp`](../../ui/acp/)) forwards to the editor's `session/request_permission` prompt for agents it owns. The audit events are log-only session records — the model only ever sees the tool result the asker derives from the outcome.

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
