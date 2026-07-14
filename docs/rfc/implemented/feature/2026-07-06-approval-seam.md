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

The entry alone provides mechanism, not a channel: with no answerer composed, every ask resolves `unavailable` and the asking tool call denies — fail-closed needs no configuration. Composing the ACP app (`@deepseek-ai/dsh-acp-agent`, as in [the acp-agent example's default tree](../../../../examples/acp-agent/README.md)) completes the loop: its bridge registers an answerer that prompts the owning editor session via `session/request_permission`, so a hook's `ask` or an escalation request surfaces as a one-shot Allow/Reject prompt attached to the already-streamed tool call. `policy: never` is the unattended stance — every ask auto-rejects deterministically, stated in the system prompt, no human in the loop. `policy` is validated against the closed list at plugin load; anything else throws.

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

After request validation and a successful `approval/asked` append, the answerer phase always resolves to a closed `ApprovalOutcome` — `allowed-once` / `rejected` / `cancelled` / `unavailable`. `ApprovalRequest` is a readonly same-process contract, so the service borrows its routing identity and cancellation signal instead of copying the record or capturing a parallel callback bundle. It dispatches the `approval/request` waterfall, races the request signal (abort settles `cancelled`; a late answer is discarded, never double-audited), contains a throwing answerer as `unavailable`, normalizes a rogue non-vocabulary return to `unavailable`, and lands the log-only audit pair `approval/asked`/`approval/decided` (paired by the branded `ApprovalRequestId`) on the request agent's session log. Request acceptance and either pre-commit audit append may still reject; returning a decision that could not be logged would violate the pair. Session owns post-commit observer containment, so a callback failure cannot turn an authoritative audit append into a rejected request or suppress the matching event. Grants are one-shot by definition: `allowed-once` authorizes the single asked-about action, never a class of future ones, and the service stores nothing between requests. `request()` also throws before appending anything when the agent's session has no open turn — the audit pair must be turn-enclosed, the turn being the durable log's commit/replay boundary (a bare event between turns is dropped as crash tail on reload); every ask path runs mid-turn already, and idle asks are a deferred design.

Answerers are the policy, and they are `approval/request` waterfall listeners. The waterfall buys exactly what the seam needs: with zero listeners the dispatch falls through to the caller-supplied default — `unavailable`, so fail-closed needs no configuration and no code in any deployment; a listener that recognizes the request's agent answers by returning an outcome without calling `next()` (the decision slot is single-occupancy, first answer wins — the same documented semantics as the `fs/write-intent` gate); a listener that does not recognize the agent MUST delegate via `next()` so another answerer or the default gets the question; and listeners dispose with their owning fiber, so an unloaded UI plugin degrades the next ask to `unavailable` instead of leaving a dangling channel. Registration order across sibling plugins is not load-order deterministic (the loader starts siblings concurrently), so a deployment composes ONE terminal answerer and reserves `prepend` listeners for decide-or-delegate gates.

`ApprovalRequest` carries the asking `agent` (routes the question; receives the audit events), the `toolName`, the optional exact `callId`, the asker's human-readable `reason`, and the optional `signal`. The caller retains ownership and honors the readonly contract for the duration of `request()`. The vocabulary is deliberately self-contained — it names the tool-call by the `CallId` brand from `dsh-llm` and never imports `dsh-tools` — because `dsh-tools` depends on `dsh-user-approval` (the ask routing) and a `ToolCallView` import would close a package cycle. It deliberately does NOT carry tool arguments: a UI answerer attaches the prompt to the already-streamed tool call via `callId` instead of re-rendering the call.

#### Ask routing in dsh-tools

`ToolRegistry.execute()` resolves an `ask` decision through the seam before the shared deny path: `allowed-once` proceeds to guards and dispatch, and the three non-grants deny with distinct reasons — "the user rejected…", "…was cancelled", "…no approval channel is available" — so the model can tell a human "no" from an absent channel. The seam is consumed opportunistically (`ctx.get('approval')`, the `tool-bash`/`agent-loop` pattern), not statically injected: with no ApprovalService, or after one unmounts, the next ask fails closed without gating the registry's fiber. An agent-less execution also fails closed — without an agent there is no session to audit to and no UI to route to.

#### The per-session policy tier

The seam also owns the session-scoped approval policy — the approval knob of the two-knob per-session switching design ([the sandbox RFC](2026-07-06-sandbox.md) § Per-session modes is the pattern's home: one log-only event per knob, a pure fold, THE write path, ACP config-option advertisement, and turn-anchoring). `ApprovalPolicy` is `'ask' | 'never'`, and `effectiveApprovalPolicy(events) ?? Config.policy` (default `'ask'`) decides every request BEFORE any interactive answerer: the service resolves a `'never'` session to `'rejected'` INSIDE `request()`, before dispatching the waterfall at all — no listener registration, including a later `prepend`, can sit ahead of it — while `'ask'` dispatches unchanged and falls through to fail-closed `'unavailable'` when nobody answers. Visibility follows the switching design's two layers with one asymmetry: the prompt section states ONLY `'never'` (deterministic, availability-independent — "you will be prompted" would overclaim in a composition with no answerer, and absence under a logged header is exactly how the narrator reads `'ask'` back), the narrator injects at most one coalesced notice per switch, and the audit pair still lands on every ask, including the policy's auto-rejections.

#### The ACP answerer

The bridge registers the first real answerer: it resolves the owning session through its existing `WeakMap<Agent, sessionId>` reverse map, issues `session/request_permission` with the request's `callId` as the `toolCall` reference and the one-shot options `allow_once`/`reject_once`, and maps the response — selected `allow-once` → `allowed-once`, any other selection → `rejected` (an unknown optionId from a non-conforming client never grants), client `cancelled` → `cancelled`. A request for a foreign agent — or one without a `callId`, since the protocol prompt must attach to a tool call — delegates via `next()`. A rejected RPC (client gone mid-prompt) propagates to the service, which contains it as `unavailable`. Whether a call ASKS at all is policy — a hook or `tools/pre-execute` plugin returning `ask` — never the bridge's own judgment.

The answerer routes through the bridge's reverse-map ownership seam described by [the ACP support RFC](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md), implementing the per-session permission ownership required by [the multi-session RFC](../../implemented/feature/2026-06-14-acp-multi-session.md).

#### Audit, and what the model sees

`approval/asked` / `approval/decided` are log-only session events (the `hook/invoked`/`hook/result` precedent): durable, replayable, never in the model transcript. The model's entire view of an approval is the tool result the asker derives from the outcome — reconstructability holds because that result is an ordinary logged `tool/result`. One `decided` lands per `asked`, whatever the outcome, including an already-aborted signal (settled `cancelled` without dispatching), a contained answerer failure, or a session observer that throws after either event is already appended.

#### Entities and dependencies

One package, no cycles: `dsh-user-approval` peers on `cordis`, `dsh-session` (event-map merge + append), `dsh-agent` (the `Agent` type), `dsh-llm` (`CallId`, via `dsh-brand`). `dsh-tools` and `dsh-acp` each peer on it; the escalation phase's asker lives in `dsh-tool-bash` (see [the sandbox RFC](2026-07-06-sandbox.md) § Escalation), so the sandbox family keeps its ZERO-edge relation (the executor contributes the per-call override mechanism, and transport seams never ask humans questions). The seam is one package, not the capability-seam three: the service body (dispatch + audit) has no replaceable implementation — the replaceable part is the answerer listeners, and those live with their owners (the bridge; future terminal UIs; test scripts). `@cordisjs/plugin-capability` stays orthogonal (a static grant registry answers "is this already authorized", not "ask the user now"), and `subagent-acp`'s child-side `permission` auto-answer is untouched — routing a child's approvals to the parent session is deferred (§ Deferred).

### Testing

Unit tier: the service's outcome branches (fail-closed default, first-wins slot, delegation, containment, rogue-value normalization, abort-before and abort-during with late-answer discard, fresh ids, fiber-disposal degradation), scoped routing, post-append observer throws on both audit events, and the policy tier (both values × dispatch/decide, a `'never'` decision unbypassable even by an answerer prepended AFTER the service, audit pair intact) in `dsh-user-approval`; the ask routing matrix (grant dispatches; three non-grant reasons pinned verbatim; unmounted and agent-less degrades; the registry's own exhaustiveness backstop against a non-conforming stand-in) in `dsh-tools`; the answerer (wire shape of the prompt, outcome mapping, unknown-option conservatism, foreign-agent and call-less delegation) driven through a real bridge + scripted client in `dsh-acp`.

Snapshot tier: the harness accepts scripted permission answers (`permissionAnswers` in a scenario's `input.json`, consumed FIFO; an unscripted prompt answers `cancelled`, fail closed). The seam's wire is recorded end to end in the sandbox example's suite: both escalation branches drive `session/request_permission` through this seam over scripted answers (grant and rejection), and the recorded `mode-switching` scenario pins the `'never'` prompt sentence and the policy-switch notice ([the sandbox RFC](2026-07-06-sandbox.md) § Testing).

## Deferred

- **`allow_always` grant storage** — honoring a persistent grant means designing storage, scope identity (call? path? prefix? session? time window?), and revocation; until designed, only the one-shot options are advertised ([the sandbox RFC](2026-07-06-sandbox.md) § Escalation records the open scope question).
- **A recorded hook-driven `ask` through a composed answerer** — the human-prompt wire is recorded through the sandbox example's escalation branches. The hook matrix's `hook-cc-pretool-ask` pins the no-ApprovalService fallback denial, while the hook-producer-plus-answerer composition remains on the unit tier.
- **Routing a child agent's approvals to the parent session** — `subagent-acp`'s child auto-answers its own `permission` requests; surfacing them to the parent's editor is its own design.

## Alternatives considered

- **A single registered provider instead of waterfall listeners** — rejected: a `registerProvider()` surface forces every composition question — allowlist pre-filters, external hook deciders, scripted test answers, a policy gate in front of a human — inside one provider implementation. The waterfall gets composition, fail-closed absence, and HMR disposal from machinery the runtime already has; the seam's JSDoc pins the single-decision-slot convention instead of inventing a provider registry.
- **An inline `tools/pre-execute` permission gate in the ACP bridge** — rejected: prompting for every bridge-owned call hardwires the asking POLICY into the UI plugin, cannot serve a second asker (sandbox escalation happens after execution starts, with no pre-execute moment), and leaves hook-produced `ask` decisions without a shared mechanism.
- **The generic user-interaction seam (`ctx.userInteraction`)** — rejected as the approval mechanism: the two share a skeleton (route by agent, block for a human, handle absence), but approval's contract is narrower in every dimension that matters: a closed outcome vocabulary instead of free text, a protocol-native prompt attached to a tool call instead of a generic form, mandatory fail-closed absence, and audit events. Approval therefore does not ride the shipped `packages/ui/user-interaction` / `ask_user_question` elicitation path — an elicitation form is not a permission prompt, and a free-text answer is not a closed outcome; sharing provider plumbing stays open if the two ever converge.
- **Static optional injection in `dsh-tools`** — rejected: the vendored cordis `Inject` type has no optional flag — the object form maps service names to intercept config, and a declared inject gates the fiber. `ctx.get('approval')` is the documented opportunistic-consumption pattern (the `tool-bash` owner-token lookup, the loop's persistence probe), reads presence per call, and degrades correctly across HMR without extra machinery.
- **The capability-seam three-package split** — rejected: interface/implementation/consumer fits a seam whose implementation is swappable (bash-local vs bash-sandbox). Here the service body is fixed mechanism and the variable part is listeners that live with their owners — splitting would manufacture an implementation package with nothing in it ("don't split preemptively").
- **Offering `allow_always` now** — rejected: the protocol can express it, but honoring it means designing grant storage, scope identity, and revocation (§ Deferred). Advertising an option the harness cannot honor manufactures doomed grants.

## Consequences

The implemented contract is pinned by the suites in Testing:

- With an ApprovalService and an answerer composed, a hook's `ask` reaches a human and `allowed-once` dispatches the tool; every other outcome denies with its distinct reason.
- A `'never'` session auto-rejects every ask without prompting anyone, states the policy in its prompt, and narrates switches (the shared switching mechanics are pinned in [the sandbox RFC](2026-07-06-sandbox.md)).
- Every unanswerable path fails closed to `unavailable`: no service, no listener, a foreign or agent-less request, a throwing answerer, a rogue return value, or a dead client connection.
- Every `request()` routes through its readonly agent identity and lands exactly one `approval/asked`/`approval/decided` pair on that agent's log, replayable and invisible to the model transcript; post-append observer failures cannot split the pair.
- Prompts route per-session through the bridge's ownership map; one session's prompt can never reach another session's editor.
- A deployment with no ApprovalService emits no approval prompt or approval audit events and denies every `ask` request.

Costs and accepted limits:

- **Two decide-eager answerers race for the slot.** Sibling-plugin listener order is not deterministic, so the seam cannot referee competing terminal answerers — mitigated by convention (one terminal answerer per deployment; `prepend` only for decide-or-delegate gates) rather than a priority mechanism the event bus does not have.
- **Production exercise rests on one composition.** `ask` has two producer families — the hook bridges through `tools/pre-execute`, and sandbox escalation through its own gate — with the wire recorded in the sandbox example's snapshot suite, so the seam's real-world coverage is that one composition until more deployments compose it.
- **Ownership keys on `Agent` object identity.** The answerer resolves sessions through the bridge's existing WeakMap; every current path hands the same object through the loop and the seams, but a future boundary that clones or proxies agents would make the bridge delegate and fail closed — safe, but silently UI-less — and would need session-id matching instead.

## FAQ

Behavioral and usage questions only — every "why not X?" design question lives in [Alternatives considered](#alternatives-considered), whose job is exactly that.

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
