# RFC: The approval seam — one-shot permission decisions over a waterfall of answerers

Status: implemented

## Problem

Two callers need to put one question — "may this specific action proceed?" — to a human: `tools/pre-execute`'s `ask` decision (including the Claude-Code hook bridge's `permissionDecision: ask`) and the [sandbox RFC](2026-07-06-sandbox.md)'s post-denial one-shot escalation retry. A shared seam keeps them from inventing separate outcome vocabularies, UI routing, cancellation, and audit trails, while guaranteeing that a deployment with no UI can never grant an unanswerable request.

The routing problem is ownership: an approval prompt must reach the editor session that owns the asking agent (the ACP bridge multiplexes N sessions over one connection), fail closed for agents nobody owns (in-process subagents, tests), and stay out of deployments that compose no UI (headless, CI).

## Decision

One package, `dsh-user-approval` (`packages/ui/user-approval`), owning the vocabulary and the `ctx.approval` service — the MECHANISM. The POLICY — who answers, and whether a session is asked at all — lives outside it: answerers are `approval/request` waterfall listeners registered by the plugins that own the channel (the ACP bridge; future terminal UIs; test scripts), and a per-session policy tier can decide before any human is involved. Consumers (`dsh-tools`' ask routing, the sandbox escalation gate) resolve a question to a closed outcome and derive their own tool results from it. Deliberately ONE package, not the capability-seam three (see Alternatives).

### How a deployment uses it

One `cordis.yml` entry mounts the seam. Not loading it is the fail-closed opt-out: consumers deny unanswerable requests with zero approval code registered.

```yaml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  # config:
  #   policy: never   # deployment default for sessions without an override; 'ask' when omitted
```

The entry alone provides mechanism, not a channel: with no answerer composed, every ask resolves `unavailable` and the asking tool call denies — fail-closed needs no configuration. Composing the ACP app (`@deepseek-ai/dsh-acp-demo`, as in [the acp-agent example's default tree](../../../../examples/acp-agent/README.md)) completes the loop: its bridge registers an answerer that prompts the owning editor session via `session/request_permission`, so a hook's `ask` or an escalation request surfaces as a one-shot Allow/Reject prompt attached to the already-streamed tool call. `policy: never` is the unattended stance — every ask auto-rejects deterministically, stated in the system prompt, no human in the loop. `policy` is validated against the closed list at plugin load; anything else throws.

What a composed deployment observes: `allowed-once` lets exactly that call proceed; rejection, dismissal, and channel absence deny with three distinct reasons the model can tell apart; every ask lands a durable `approval/asked`/`approval/decided` pair on the asking agent's session log; nothing about a grant persists past the call that asked.

One ask under this composition, verbatim from the sandbox example's recorded `escalation-approved` scenario — the model requests a sandbox escalation, the gate asks, the bridge prompts the owning editor, the user clicks Allow once:

```
tool/call        bash {"command": "printf 'escalated\n' > escalated.txt && cat escalated.txt",
                       "sandbox_permissions": "workspace-write",
                       "justification": "the user asked to write escalated.txt in the workspace"}
approval/asked   {"toolName": "bash", "callId": "call_00_…",
                  "reason": "escalate sandbox to workspace-write: the user asked to write escalated.txt in the workspace"}
  → session/request_permission {"toolCall": {"toolCallId": "call_00_…"},
                  "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                              {"optionId": "reject-once", "name": "Reject",     "kind": "reject_once"}]}
  ← the user picks "Allow once" on the prompt the editor attaches to the streamed bash call
approval/decided {"outcome": "allowed-once"}
tool/result      "escalated" — this one call ran under the wider mode; the grant died with it
```

The `escalation-rejected` twin ends in `{"outcome": "rejected"}` instead: nothing executes, and the model's result carries the asker's verbatim fail-closed text (`the user rejected escalating this command to "workspace-write"`). A hook's `permissionDecision: ask` rides the identical wire; only the asker and its deny texts differ (§ Ask routing in dsh-tools). Headless, the same request skips the prompt entirely and settles `unavailable`.

### Design detail

#### The seam: mechanism and policy split

After validation and an `approval/asked` append, `request()` resolves to `allowed-once`, `rejected`, `cancelled`, or `unavailable`. The service borrows the readonly request, runs the answerer waterfall, races cancellation, and normalizes thrown or invalid answers to `unavailable`. It then appends the matching `approval/decided`, paired by `ApprovalRequestId`.

Both audit events must be inside an open turn; acceptance or a pre-commit append failure rejects the request. Post-commit observers are contained by the session. `allowed-once` grants only the requested action, and the service retains no grant state.

Answerers are `approval/request` waterfall listeners. A listener returns an outcome for an agent it owns and calls `next()` otherwise. With no answerer, the default is `unavailable`; unloading a UI therefore fails closed without leaving a channel. Because sibling registration order is not deterministic, a deployment composes one terminal answerer and uses `prepend` only for decide-or-delegate gates.

`ApprovalRequest` carries the agent, tool name, optional `callId`, reason, and signal. The agent routes both the prompt and audit events. The request uses `dsh-llm`'s `CallId` without importing `dsh-tools`, avoiding a package cycle. Tool arguments are omitted because UI answerers attach to the already-rendered call.

#### Ask routing in dsh-tools

`ToolRegistry.execute()` sends `ask` through the approval seam before the deny path. Only `allowed-once` proceeds; rejection, cancellation, and an unavailable channel produce distinct model-visible reasons. The registry looks up the optional service per call, so an absent or unloaded service fails closed without gating the registry fiber. Agent-less execution also fails closed because it cannot be routed or audited.

#### The per-session policy tier

The seam owns the session policy `'ask' | 'never'`, following the switching contract in the [sandbox RFC](2026-07-06-sandbox.md). The effective session or config policy is applied before answerers: `'never'` rejects inside `request()`, while `'ask'` dispatches and falls through to `unavailable` when unanswered. The prompt states only deterministic `'never'`; the narrator reports switches, and every request still receives its audit pair.

#### The ACP answerer

The ACP bridge finds the owning session, sends `session/request_permission` for the `callId`, and maps one-shot allow, reject, and cancel responses to the seam vocabulary. Unknown selections never grant. Foreign agents and requests without a `callId` delegate via `next()`; RPC failure becomes `unavailable`. The bridge answers requests but does not decide which calls require approval.

The answerer routes through the bridge's reverse-map ownership seam described by [the ACP support RFC](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md), implementing the per-session permission ownership required by [the multi-session RFC](../../implemented/feature/2026-06-14-acp-multi-session.md).

#### Audit, and what the model sees

`approval/asked` and `approval/decided` are durable log-only events. The model sees only the asker's logged `tool/result`. Every accepted request appends one matching decision, including cancellation and contained answerer failures.

#### Entities and dependencies

`dsh-user-approval` owns the fixed dispatch-and-audit mechanism; `dsh-tools` asks and `dsh-acp` answers. Replaceable answerers remain listeners in their channel-owning plugins, so a three-package capability split would add an empty implementation layer. Sandbox executors remain transport-only, and static capability grants remain separate from interactive approval.

### Testing

- **Unit/integration:** cover first-wins delegation, fail-closed defaults, malformed and throwing answerers, cancellation races and late-answer discard, audit pairing despite observer failures, unbypassable `'never'`, distinct tool-denial reasons, and ACP per-session routing/outcome mapping.
- **Snapshot:** script permission answers through both sandbox escalation branches and pin the `'never'` prompt plus policy-switch notice. Hook-produced asks without a composed answerer remain covered as fail-closed denial.

## Deferred

- **`allow_always` grant storage** — honoring a persistent grant means designing storage, scope identity (call? path? prefix? session? time window?), and revocation; until designed, only the one-shot options are advertised ([the sandbox RFC](2026-07-06-sandbox.md) § Escalation records the open scope question).
- **A recorded hook-produced ask with a composed answerer** — escalation records the human-prompt wire, while the current hook fixture pins the no-service denial; their combined producer/answerer path remains unit-covered.
- **Routing a child agent's approvals to the parent session** — `subagent-acp`'s child auto-answers its own `permission` requests; surfacing them to the parent's editor is its own design.

## Alternatives considered

- **A single registered provider instead of waterfall listeners** — rejected: a `registerProvider()` surface forces every composition question — allowlist pre-filters, external hook deciders, scripted test answers, a policy gate in front of a human — inside one provider implementation. The waterfall gets composition, fail-closed absence, and HMR disposal from machinery the runtime already has; the seam's JSDoc pins the single-decision-slot convention instead of inventing a provider registry.
- **An inline `tools/pre-execute` permission gate in the ACP bridge** — rejected: prompting for every bridge-owned call hardwires the asking POLICY into the UI plugin, cannot serve a second asker (sandbox escalation happens after execution starts, with no pre-execute moment), and leaves hook-produced `ask` decisions without a shared mechanism.
- **The generic user-interaction seam (`ctx.userInteraction`)** — rejected as the approval mechanism: the two share a skeleton (route by agent, block for a human, handle absence), but approval's contract is narrower in every dimension that matters: a closed outcome vocabulary instead of free text, a protocol-native prompt attached to a tool call instead of a generic form, mandatory fail-closed absence, and audit events. Approval therefore does not ride the shipped `packages/ui/user-interaction` / `ask_user_question` elicitation path — an elicitation form is not a permission prompt, and a free-text answer is not a closed outcome; sharing provider plumbing stays open if the two ever converge.
- **Static optional injection in `dsh-tools`** — rejected: the vendored cordis `Inject` type has no optional flag — the object form maps service names to intercept config, and a declared inject gates the fiber. `ctx.get('approval')` is the documented opportunistic-consumption pattern (the `tool-bash` owner-token lookup, the loop's persistence probe), reads presence per call, and degrades correctly across HMR without extra machinery.
- **The capability-seam three-package split** — rejected: interface/implementation/consumer fits a seam whose implementation is swappable (bash-local vs bash-sandbox). Here the service body is fixed mechanism and the variable part is listeners that live with their owners — splitting would manufacture an implementation package with nothing in it ("don't split preemptively").
- **Offering `allow_always` now** — rejected: the protocol can express it, but honoring it means designing grant storage, scope identity, and revocation (§ Deferred). Advertising an option the harness cannot honor manufactures doomed grants.

## Consequences

- Only `allowed-once` dispatches an asked-about action; absent, rejected, cancelled, or failed answer paths deny.
- Session ownership routes prompts, policy, and audit events without crossing editor sessions.
- Accepted requests append one durable audit pair; the model sees only the resulting tool result.
- A deployment without the service emits no approval prompt or audit events and denies every `ask` at the tool boundary.

Costs and accepted limits:

- **Two decide-eager answerers race for the slot.** Sibling-plugin listener order is not deterministic, so the seam cannot referee competing terminal answerers — mitigated by convention (one terminal answerer per deployment; `prepend` only for decide-or-delegate gates) rather than a priority mechanism the event bus does not have.
- **Production exercise rests on one composition.** `ask` has two producer families — the hook bridges through `tools/pre-execute`, and sandbox escalation through its own gate — with the wire recorded in the sandbox example's snapshot suite, so the seam's real-world coverage is that one composition until more deployments compose it.
- **Ownership keys on `Agent` object identity.** The answerer resolves sessions through the bridge's existing WeakMap; every current path hands the same object through the loop and the seams, but a future boundary that clones or proxies agents would make the bridge delegate and fail closed — safe, but silently UI-less — and would need session-id matching instead.

## FAQ

- **What happens in a deployment with no answerer at all (headless, CI)?** Every ask falls through the empty waterfall to `unavailable` and the tool call denies with the "no approval channel is available" reason. Fail-closed is the zero-listener default, not a configuration.
- **Can a grant persist — "always allow this"?** No. `allowed-once` authorizes the single asked-about action and the service stores nothing between requests; `allow_always` is deliberately not advertised until grant storage is designed (§ Deferred).
- **What does the model see of an approval?** Only the tool result the asker derives from the outcome — the audit pair never enters the transcript. The three non-grant reasons are distinct, so the model can tell a human "no" from a dismissed prompt from a missing channel.
- **Who decides whether a call asks in the first place?** Policy producers: a hook returning `permissionDecision: ask`, any `tools/pre-execute` listener, or the sandbox escalation gate. The seam and the bridge only route and answer; neither injects its own judgment about what deserves a prompt.
- **What happens when the user dismisses the prompt, or the turn aborts mid-ask?** Dismissal maps to `cancelled` with its own deny text. An already-aborted signal settles `cancelled` without dispatching; an abort during the ask discards the late answer — one audit pair either way, never two.
- **What if the client answers with an option the harness never offered?** Any selection other than the offered `allow_once` maps to `rejected` — an unknown optionId from a non-conforming client can never grant.
- **How do subagents' approvals route?** An agent no answerer owns delegates through the whole waterfall and fails closed — in-process subagents are deliberately unanswerable. `subagent-acp`'s child-side auto-answer is separate; routing a child's asks to the parent's editor is deferred (§ Deferred).
- **What does `policy: 'never'` actually change at runtime?** The service resolves every ask for that session to `rejected` before dispatching any answerer (in-service, so no registration order can bypass it); the system prompt states the policy; switches are narrated at boundaries; the audit pair still lands for every auto-rejection.
- **What happens across a hot reload, or when the UI plugin unloads mid-session?** Answerers dispose with their owning fiber, so the next ask degrades to `unavailable` instead of hanging on a dead channel; remounting re-registers the answerer with no catch-up state.
- **Where does the user see what they are approving?** On the tool call itself: the prompt attaches to the already-streamed call via `callId` — arguments included — and adds the asker's human-readable `reason`; the request carries no argument copy of its own.

## Prior art

In-repo precedents this design copies or contrasts with:

- The `fs/write-intent` gate (`packages/fs/fs/`) — the documented single-occupancy decision-slot waterfall semantics (first answer wins, delegate via `next()`) the answerer contract reuses.
- `hook/invoked`/`hook/result` — the log-only audit-pair precedent `approval/asked`/`approval/decided` follows; [the hook-bridges RFC](2026-06-30-hook-bridges.md) ships `permissionDecision: ask`, the first producer.
- [The interception-seams RFC](2026-06-30-interception-seams.md) — the `tools/pre-execute` `allow`/`deny`/`ask` vocabulary whose `ask` this seam services.
- [The ACP support RFC](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md) — the `WeakMap<Agent, sessionId>` ownership seam the answerer routes through; [the multi-session RFC](../../implemented/feature/2026-06-14-acp-multi-session.md) — the per-session permission-ownership blocker this implements.
- The opportunistic `ctx.get()` consumption pattern (`tool-bash`'s owner-token lookup, the loop's persistence probe) — how `dsh-tools` consumes the seam without gating its fiber on it.
