# Agent Note: Web subagent catalog and human continuation

Status: implemented

English | [中文](2026-07-27-web-subagent-conversations.zh.md)

## Problem

Continuable background subagents have durable identities, persisted transcripts, inbox-driven Activations, and a direct-child catalog. The model can discover and continue them through `list_agents` and `send_message`, but the Web client has no equivalent product path. Its session tree knows only lineage, so it cannot distinguish a continuable subagent from an ordinary fork, and opening an inactive session through the ordinary history path resumes an Agent merely to display it.

Treating a child as an ordinary Web session would violate the [continuable subagent contract](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md). Ordinary `session.history` and `session.prompt` address an Agent directly; a continuable child must display from persistence without materializing an Activation and accept human input through `SubagentService.followup()` so the Agent inbox owns ordering while the continuation manager owns authorization, cold resume, durability, and teardown.

The UI also needs to preserve the [durable catalog](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) semantics. `running` and `inactive` are live-preferred session-activity snapshots, not success outcomes or delivery promises; corrupt, unsupported, and unavailable children remain explicit diagnostics; and only direct continuable children belong in one catalog response.

## Decision

The Web product will expose direct continuable children from the selected session's title header and let a user open their persisted conversations. A child conversation will reuse the existing event fold, message rendering, streaming path, title, and input chrome, but its history and prompt operations will use a dedicated subagent address `{ parentSessionId, childSessionId }` rather than the ordinary session RPCs.

Human input will call `ctx.subagents.followup(parent, childSessionId, content, { source: { kind: 'user', rpcId }, signal })`. A resident Activation admits the message into its Agent inbox; an absent Activation cold-resumes the same durable Session before inbox admission. The host will never resume the parent merely to enable interaction: the exact direct-parent Agent must already be live to authorize delivery. When it is absent, the child remains a read-only transcript.

This proposal covers Web discovery, transcript viewing, and human continuation. It does not turn a subagent into a user-owned conversation that survives independently of its parent; that product belongs to [interactive side sessions](../../proposed/feature/2026-07-08-interactive-side-sessions.md).

## Design context

The Figma [subagent list](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-14602&p=f), [hierarchical expansion](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-15917&p=f), and [child conversation](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=388-18584&p=f) frames are the interaction and visual references for this proposal. They are non-normative presentation context: this Agent Note owns lifecycle, wire, failure, and acceptance contracts, and a later design-file edit does not change those contracts without a corresponding note update.

| Design intent | Contract in this proposal |
| --- | --- |
| The session header shows a subagent count and opens a compact list. | The header action shows the direct durable catalog, including healthy entries and explicit diagnostic rows. |
| Selecting a row opens a child with ordinary conversation chrome, title, transcript, and composer. | The child reuses the conversation UI, but history and input route through the addressed subagent RPCs. The composer sends human follow-ups only while the exact parent Agent is live and otherwise explains the read-only state. |
| Nested agents can be explored progressively. | Expanding a row loads only that child's direct catalog and inserts it as the next tree level. The client never materializes an eager recursive catalog. |
| Rows show labels, activity dots, and relative time, while the sidebar omits duplicate subagent rows. | Labels and coarse `running` or `inactive` activity come from the catalog. An optional log-backed title and relative last-activity time come from the ordinary session summary; they are not Activation outcome or duration. A durable coarse `SessionHeader.origin` classification removes duplicate subagent rows without hiding ordinary forks. |

## Product contract

Every selected session may show a header action labeled `<N> subagents`, where `N` counts healthy `kind: 'child'` entries returned by `listChildren()` and excludes diagnostics. The action is absent when the complete response has neither a child nor a diagnostic. Opening it shows the direct children in service order, with the durable creation label, an activity indicator, and a disabled diagnostic row for every corrupt, unsupported, or unavailable candidate.

`running` means the child Session is live in the host's logical session corpus. `inactive` means the child exists only in persistence and may be resumed by a later message. The UI renders them as `正在处理` and `已完成`, but the latter is only presentation for inactivity, not a succeeded, failed, or cancelled outcome. A row may show the ordinary session summary's relative `updatedAt` as a last-activity hint, but it does not present that value as Activation elapsed time. A listed child's `running`/`inactive` value updates live: the catalog consumer flips it in place from the same `host/session-status` frame that drives ordinary session `running`, so a child settling `running → inactive` needs no navigation or refetch. That frame carries only liveness, so a child's `label`, diagnostic reason, health transition, or membership change is not in it and still resolves through a `subagent.list` refetch; cross-process settlement and the window before a refetch lands remain snapshot-stale, and `subagent.prompt`'s result, not the activity label, is delivery-time authority.

Selecting a healthy row opens the child in the existing conversation region, whose resident header shows the child title. The header dropdown is an ARIA tree: expanding a row loads that child's direct catalog lazily, and further expansion repeats the same operation at any depth. Every visible branch retains its own direct-parent address and catalog lifecycle; collapsing a branch or closing the tree stops membership consumption for that branch and its expanded descendants.

The composer is enabled only when the catalog adapter reports that the exact parent Agent is live. Submitting clears the draft optimistically and restores it on an explicit not-delivered response, matching the ordinary composer failure behavior. A successful response carries the accepted inbox `messageId`; it does not expose whether an Activation was resident or cold-resumed, or promise that the resulting turn completed successfully.

When the parent is not live, the transcript stays readable and the composer presents a read-only explanation. The adapter does not auto-resume the parent, because a replacement Agent is not the retained owner of an existing Activation. Visiting the parent through its ordinary session path may make a parent Agent live for a later new Activation, but child navigation itself has no such side effect.

The ordinary Stop action is hidden for subagent conversations in this version. `session.cancel` would bypass continuation-manager ownership and child-first teardown, while the subagent service exposes no per-message or per-Activation cancellation operation after inbox acceptance. A correct cancellation control requires a separately designed Activation observation and authority surface.

## Host adapter and wire contract

`@deepseek-ai/dsh-host-apiproxy` will own a browser-safe `subagents` domain alongside `sessions`, with zod-validated unary methods registered through the existing `RpcMethodMap` and fetch carrier:

- `subagent.list` takes `parentSessionId`, calls `ctx.subagents.listChildren(parentSessionId, signal)`, and returns the complete ordered entry array plus whether `ctx.agents.get(parentSessionId)` currently resolves the required live parent. Parent availability is a UI hint; `subagent.prompt` remains the delivery-time authority.
- `subagent.history` takes the direct parent id, child id, and the ordinary history page arguments. It first verifies that the child is a healthy entry in that parent's durable catalog, then reads the child through `ctx.sessionQuery` without publishing or resuming an Agent. It returns the same raw-event-plus-render-intent shape and message-aligned pagination contract used by ordinary history so the browser uses one fold.
- `subagent.prompt` takes the direct parent id, child id, and `ContentBlock[]`. It requires the exact live parent from `ctx.agents`, calls `ctx.subagents.followup()` with human attribution, the request's rpcId, and the operation signal, and returns `{ messageId }`. The adapter never bypasses the service through direct `agent.followup()`, `agent.steer()`, or generic `ctx.agents.resume()` calls.

The gateway maps missing-parent, catalog diagnostic, not-resumable, unauthorized, ownership-conflict, cancelled, and not-delivered failures to typed RPC errors without leaking the model-hidden descriptor. A race after `subagent.list` may still make `subagent.prompt` fail; the prompt result, not the earlier availability bit or `running` activity, is authoritative.

The mux remains the live event path. A persisted child contributes no live subscription merely because its history is viewed. When `subagent.prompt` starts a cold-resume Activation, publication makes the existing mux subscribe to that child and the browser reconciles subsequent events by sequence. Reconnect rebuilds an addressed child from `subagent.history`, not ordinary `session.history`.

The adapter belongs in `dsh-host-apiproxy`, which owns the channel-independent contract and host implementation. `dsh-host-webserver` remains only the HTTP/SSE carrier and gains no subagent behavior. The browser imports the protocol through the existing connection client and never reaches host `ctx` directly, preserving the [GUI RPC layering](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

## Client object layer and presentation

The React-free client runtime will own durable catalog snapshots, in-flight refreshes, subagent addresses, and prompt/history routing. Opening a catalog child records its `{ parentSessionId, childSessionId }` address before opening the resident `Session`; that Session uses `subagent.history` and `subagent.prompt`, while ordinary sessions keep their existing transport. Re-selecting the same child through an ordinary selection path retains the known address so navigation cannot silently switch transports. A child address discovered from the catalog is the only browser fact that selects this route; `parentId` or `origin` alone is insufficient because ordinary forks share the lineage field and origin is only a presentation classifier.

Catalog data is projected through the existing sessions snapshot consumed by `useSessions`, rather than placed in a component store or exposed through a feature-defined hook. The tree reads ordinary session summaries from the same snapshot for optional title and last-activity presentation. While the root or an expanded descendant catalog is open, its consumer attaches to the existing host-frame fan-out, as the workspaces manager already does: a `host/session-status` frame naming a listed child flips that child's `running`/`inactive` activity in place through the same optimistic mutation path as ordinary session `running`, with no `subagent.list` refetch. A `host/session-added` frame whose parent matches an open branch triggers one debounced, single-flight `subagent.list` refetch to admit the new member and its label and descriptor. Component-local state owns dropdown visibility, expanded branch ids, and keyboard focus.

`ui-conversation` will declare and render a session-scoped `conversation.session.header.actions` list slot beside the title. The existing `@deepseek-ai/dsh-client-ui-subagent` plugin will register the catalog trigger and dropdown there, and will provide the subagent-specific read-only composer presentation through the conversation's existing composition points. Extending that package keeps one Web subagent feature owner; its current `@label` reference source remains plain-text model input and does not acquire continuation semantics in this proposal.

The presentation follows existing styling and accessibility rules: Chinese product copy, token-only light/dark colors, tree and treeitem semantics, ArrowRight/ArrowLeft branch disclosure, linear ArrowUp/ArrowDown navigation, focus returned to the trigger on close, activity communicated by text as well as color, and disabled diagnostic rows that remain readable. The component receives only derived props and injected callbacks; it never receives `ctx` or a host service.

## Default Web assembly

The `dsh web` composition will mount the SQLite session-query provider beside JSONL persistence, with its database under the configured session persistence root. Both in-process spawn and fork delegation tools will select `backgroundMode: continuable`; that route uses the continuation manager and Agent inbox rather than Tasks. The host catalog projection excludes one-shot entries, while remote ACP runs remain outside it because they publish no local child Session.

The default Web composition will mount the model-facing `send_message` and `list_agents` adapters for coordinator parity, but the GUI will not call those tools; it will call the shared `SubagentService` through the host RPC adapter. Their model-visible schemas and snapshots will be verified independently from the GUI transcript.

## Alternatives considered

**Reuse ordinary `session.history` and `session.prompt`.** Rejected because both paths resume or drive the child Agent directly and bypass continuation-manager authority and inbox admission. Display must be non-activating, and human input must share the same follow-up or cold-resume operation as parent input.

**Put the adapter in `dsh-host-webserver`.** Rejected because subagent listing and continuation are channel-independent client capabilities. The webserver carries validated RPC calls and SSE frames; it does not own harness services or business routing.

**Create another UI package.** Rejected because `ui-subagent` already owns Web subagent references and is the natural feature boundary for catalog, navigation, and human continuation. The conversation package owns only the header slot and generic conversation chrome.

**Auto-resume an absent parent when the user submits.** Rejected because human continuation is authorized through the exact live parent Agent. Silent parent activation also turns a child-page gesture into an unexpected parent lifecycle mutation.

**Expose ordinary cancel immediately.** Rejected because Agent cancellation bypasses continuation-manager ownership and child-first teardown. A correct cancel control needs the current Activation identity plus an owner-authorized operation that can define whether it cancels one inbox message, one turn, or the residency epoch, including Activations the GUI did not start.

**Add Activation outcome and timing fields to the durable catalog.** Deferred because the catalog intentionally describes durable child identity and coarse live presence. A durable Activation record is a separate backend contract and should not be inferred from session presence or the last `turn/end`.

**Build an eager recursive tree.** Rejected because `listChildren()` is direct and can scan every candidate log. The presentation composes a recursive tree from lazy direct-child queries, preserving each catalog's ordering and diagnostic semantics without multiplying work across an unseen hierarchy.

**Infer sidebar filtering from lineage or a global catalog scan.** Rejected because ordinary forks share `parentSession`, while a global catalog scan is parent-addressed and too expensive for a navigation classifier. Every in-process subagent-backed session instead stamps `SessionHeader.origin: 'subagent'` before publication; `session.list` and `host/session-added` project it to the client, and the shared sidebar filter omits only those rows. The header catalog remains the navigation entry point and descriptor authority; `origin` never proves lifecycle mode, resumability, or authorization.

**Push catalog changes as a dedicated server stream.** Deferred in favor of reusing the existing `host/session-status` and `host/session-added` fan-out. A `subagent.catalog` delta frame would make membership and diagnostics fully live without any refetch, but it is a new host wire contract and a real-time projection over the durable catalog — exactly the derived index the [durable catalog](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) leaves to measured scale. The first version flips activity from the existing liveness frame and refetches only on membership change.

**Let the child remain independently interactive after the parent disappears.** Rejected as a reinterpretation of continuable background work. Independent lifetime, user ownership, and merge-back semantics belong to interactive side sessions.

## Testing

- The default Web composition creates continuable spawn and fork children and mounts the session-query and continuation surfaces required for durable listing and human follow-up.
- A selected parent displays its complete direct-child catalog in stable service order, including healthy labels/activities and explicit disabled diagnostics; an empty healthy catalog contributes no header action. Expanding a child fetches its direct catalog, displays the next level with tree semantics and direct-parent addresses, and recursively closes descendant consumers when its branch closes.
- Opening a persisted child renders its event transcript and title header without publishing or resuming either the child or its parent.
- A child with a live parent submits through `SubagentService.followup()` with human attribution; the UI receives the accepted inbox `messageId` and receives the resulting child events through the existing mux and fold.
- A listed `running` child settling to `inactive` updates its activity in place from the live frame stream without a `subagent.list` refetch; a newly created direct child appears after one debounced refetch.
- A child whose parent is absent remains readable and rejects input without auto-resuming the parent. No child history, prompt, or stop gesture calls the ordinary Agent APIs.
- Refresh and reconnect rebuild an addressed child through the subagent history path without duplicating events or losing events emitted across cold-resume publication.
- Both grouped and flat sidebars omit `origin: 'subagent'` rows, including the current child, while ordinary fork rows remain visible; the same-child ordinary selection path retains the catalog-derived address and therefore keeps subagent history/prompt routing.
- Host protocol tests pin schemas, id echoing, direct-parent validation, non-activating history, live-parent enforcement, error mapping, and inbox-message acknowledgement. Client object tests pin catalog/address state and transport selection; jsdom tests pin the header tree, lazy nested disclosure, diagnostics, enabled/read-only composer states, keyboard behavior, and draft restoration.
- A keyless assembled Web snapshot demonstrates a settled continuable child plus a descriptor-bearing persisted grandchild, progressive catalog expansion without Activation, opening from persistence, and accepting one human follow-up into a cold-resumed Activation's inbox.

## Consequences

- The feature is built on the continuation and durable-catalog contracts; changes to their stacked implementation may require the host adapter and fixtures to move with them before this proposal can ship.
- `listChildren()` may rescan persistence and child logs (O(D×C + ΣLᵢ) per the durable catalog). Activity changes are therefore applied live from `host/session-status` without a refetch; only membership changes trigger a debounced, single-flight `subagent.list` reload, so the scan does not run on every render or status frame.
- Parent availability and child activity are process-local snapshots. Publication, Activation disposal, another sender, or another process may win after listing; explicit prompt failure remains normal behavior rather than an invariant violation.
- A child Activation may publish between history fetch and mux subscription. The existing sequence reconciliation must be proven against this cold-to-live, subagent-specific open path.
- Switching the default Web delegation tools to continuable background mode changes the model-visible acknowledgement and durability requirements for `run_in_background`; snapshot coverage must land with the assembly change.
- Persisted subagent origin adds one coarse product-classification field to every local child header and its list/increment projections. It is intentionally weaker than the descriptor and addressed continuation contracts, so navigation de-duplication cannot become an authorization shortcut.
- The feature has no correct cancellation button, durable outcome, Activation duration, deletion, pagination for the catalog, or independently interactive offline child. The UI must not imply those capabilities; its relative time is only the session summary's last-activity hint.
