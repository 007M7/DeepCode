# Agent Note: Web subagent catalog and human continuation

Status: implemented

English | [中文](2026-07-27-web-subagent-conversations.zh.md)

## Problem

Session-backed subagents have durable identities, persisted transcripts, and a direct-child catalog, but the Web client otherwise sees only ordinary session lineage. It cannot distinguish a subagent from a fork, discover descriptor mode, or view a cold child without using the ordinary history path that resumes an Agent.

The browser must preserve the [continuable subagent contract](../../implemented/feature/2026-07-28-continuable-subagent-conversations.md): a continuable child has at most one process-local Activation, accepts later work only through the exact live direct parent, and uses the Agent inbox as its sole FIFO. Viewing history must not create an Activation. Once an inbox message is accepted, the HTTP caller neither owns its execution nor gains a cancellation handle.

The UI must also preserve the [durable catalog](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md). The catalog contains both one-shot and continuable children, retains per-child diagnostics, and reports only the live-preferred activity snapshot `running` or `inactive`. Activity is not a durable outcome or a promise that continuation will succeed.

## Decision

The Web product exposes the selected session's direct session-backed subagents from a header action. Users can lazily expand descendant catalogs and open either mode in the existing conversation region. A one-shot child is permanently read-only. A continuable child accepts human follow-ups only while its exact direct-parent Agent is live; otherwise its persisted transcript remains readable with a recovery explanation.

Every opened child carries a catalog-derived address `{ parentSessionId, childSessionId, mode }`. The mode-bearing address, not lineage or the coarse origin marker, selects dedicated history and prompt transports. History reads the persisted session without activation. A continuable prompt calls `ctx.subagents.followup()` and succeeds at inbox acceptance with `{ messageId }`; it does not steer an open turn, expose an Activation, wait for completion, or return an outcome.

The ordinary Stop action is absent from addressed child conversations. `SubagentService.followup()` owns admission only until inbox acceptance and intentionally exposes no public child cancellation operation. A later cancellation design needs an explicit authority and lifecycle contract rather than falling through to `session.cancel`.

This decision covers Web discovery, transcript viewing, and parent-authorized human continuation. It does not make a subagent independently user-owned; that product remains [interactive side sessions](../../proposed/feature/2026-07-08-interactive-side-sessions.md).

## Design context

The Figma [subagent list](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-14602&p=f), [hierarchical expansion](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=383-15917&p=f), and [child conversation](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=388-18584&p=f) frames are non-normative interaction and visual references. This note owns lifecycle, wire, and failure semantics.

| Design intent | Shipped contract |
| --- | --- |
| The session header opens a compact child list. | The action shows every direct catalog entry in service order, including disabled diagnostics. |
| Selecting a row reuses the conversation UI. | Addressed history never activates the child; only a continuable row with a live parent retains the ordinary composer. |
| Nested agents expand progressively. | Each disclosure loads only that row's direct catalog and retains its own parent address. |
| Rows show labels, state, and relative time without duplicating sidebar rows. | Mode and `running`/`inactive` activity are textual as well as visual; optional title and time come from summaries. `SessionHeader.origin` removes duplicate navigation rows but grants no capability. |

## Product contract

The header action count includes healthy `kind: 'child'` entries and excludes diagnostics. It is absent only after a complete empty response. The tree presents continuable and one-shot rows, falling back to the session id when an optional one-shot label is absent. Corrupt, unsupported, and unavailable candidates remain visible as disabled diagnostic rows.

`running` means the logical child record is live in the session corpus; `inactive` means it exists only in persistence. The UI does not translate either value into success, failure, cancellation, completeness, or resumability. `host/session-status` updates known activity in place. Membership, labels, mode, and diagnostics still require a debounced `subagent.list` refresh while the affected branch is open. A prompt response remains delivery-time authority.

Selecting a row records its exact address before opening the resident client `Session`. History pagination, event folding, tool render intents, titles, breadcrumbs, and live mux reconciliation reuse the ordinary conversation machinery. The catalog is an ARIA tree with lazy ArrowRight/ArrowLeft disclosure, linear ArrowUp/ArrowDown navigation, Home/End, Escape, and focus restoration.

A one-shot row always replaces the composer with copy explaining that the execution record is read-only. A continuable row does so only while `parentAvailable` is false. When enabled, its Send action admits another FIFO turn even if the child is currently running; it never becomes Stop. Prompt failures retain the draft through the ordinary error behavior.

Agent-bound auxiliary controls are unavailable in addressed child views. In particular, the model selector and `/model` contribution do not call ordinary `session.models` or `session.selectModel`, because either route would activate persisted child history outside the direct-parent continuation seam.

## Host adapter and wire contract

`@deepseek-ai/dsh-host-apiproxy` owns a browser-safe `subagents` domain:

- `subagent.list` takes `parentSessionId`, calls `ctx.subagents.listChildren(parentSessionId, signal)`, returns the complete ordered entries, and includes whether the exact parent currently resolves from `ctx.agents`.
- `subagent.history` takes the full mode-bearing address plus ordinary page arguments. It verifies the child and mode against the direct catalog, reads through `ctx.sessionQuery.readSession()`, rechecks direct lineage, and returns the ordinary raw-event, render-intent, pagination, and host-computed session-projection baseline without publishing an Agent.
- `subagent.prompt` accepts only a `mode: 'continuable'` address and `ContentBlock[]`. It requires the exact live parent, revalidates the catalog address, calls `ctx.subagents.followup(parent, childId, content, { source, signal })`, and returns the accepted `MessageId`.

The gateway maps missing parent, missing or diagnostic catalog entries, not-resumable and unauthorized children, request cancellation, and temporarily unavailable continuation admission to typed RPC errors. It does not expose descriptor or provider details. A list/prompt race is normal: the prompt result, not the earlier availability or activity snapshot, is authoritative.

Viewing persisted history creates no mux subscription by itself. When a follow-up materializes a cold child Activation, the existing Host and mux streams publish its lifecycle and events. Reconnect rebuilds the addressed window through `subagent.history`.

The adapter stays in `dsh-host-apiproxy`; `dsh-host-webserver` remains a carrier. Browser code imports the contract through the existing connection package and never reaches host `ctx`, preserving the [GUI RPC layering](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

## Client object layer and presentation

The React-free runtime owns catalogs, single-flight refreshes, retained addresses, availability hints, and transport selection. Re-selecting a known child retains its address so navigation cannot silently switch to ordinary session APIs. Restored navigation persists the full mode-bearing address.

Catalogs ride the standard `useSessions` snapshot. Component-local state owns menu visibility, expanded branches, and focus. `ui-conversation` declares the generic header-action list slot and dispatches the current conversation snapshot through its composer chain; it contains no subagent-specific takeover flag. `@deepseek-ai/dsh-client-ui-subagent` registers the catalog action and elects a reason-specific read-only composer from ordinary owner props. Components receive derived props and callbacks, never `ctx`.

Every in-process subagent child stamps `SessionHeader.origin: 'subagent'` before publication. Session list summaries and incremental Host frames project it so grouped and flat sidebars omit duplicate child rows while preserving ordinary forks. Descriptor mode and catalog verification remain the authority for navigation, continuation, and authorization.

The package's existing `@label` source remains separate plain-text model input. It does not resolve labels to addresses or acquire continuation semantics.

## Default Web assembly

The shipped Web composition mounts SQLite session query beside JSONL persistence and configures spawn and fork background delegation as continuable. It also mounts the model-facing `send_message` and `list_agents` adapters for coordinator parity, but the GUI calls the shared `SubagentService` through the host RPC domain rather than invoking model tools. One-shot children remain catalog-visible and read-only.

## Alternatives considered

**Reuse ordinary session APIs.** Rejected because ordinary history may resume the child and ordinary prompt drives it without direct-parent continuation authority.

**Put the adapter in the webserver.** Rejected because catalog and continuation are channel-independent client capabilities; the webserver only carries validated messages.

**Create a new UI package.** Rejected because `ui-subagent` already owns Web subagent references and is the coherent owner for catalog and addressed-child presentation.

**Auto-resume an absent parent.** Rejected because continuation requires the exact live direct parent. Child navigation must not mutate the parent lifecycle.

**Expose ordinary cancellation.** Rejected because the accepted inbox turn outlives its admission request and the continuation seam exposes no authority-safe cancellation handle.

**Show only continuable children.** Rejected because the durable catalog deliberately describes both session-backed modes. One-shot transcripts remain useful even though they never accept follow-ups.

**Infer mode or sidebar filtering from lineage.** Rejected because ordinary forks share `parentSession`. The descriptor-backed catalog owns mode; the separate `origin` marker is only a cheap navigation classifier.

**Build an eager recursive tree or dedicated catalog stream.** Rejected for the current scale. Lazy direct-child reads preserve ordering and diagnostics; existing Host frames update activity and trigger bounded membership refreshes.

**Let a child remain independently interactive after its parent disappears.** Rejected because independent lifetime and user ownership require side-session semantics.

## Testing

- Host protocol tests pin schemas, id echoing, mode verification, non-activating history, exact-parent enforcement, FIFO admission receipts, cancellation, and sanitized failure mapping.
- Client object tests pin retained and restored addresses, one-shot read-only rejection, history routing, continuable prompt routing, no addressed cancellation, suppression of Agent-bound model controls, live activity flips, and membership refresh.
- jsdom tests pin mixed-mode rows, diagnostics, lazy descendant disclosure, direct-parent addresses, keyboard behavior, and both read-only reasons.
- The keyless assembled Web snapshot contains an inactive continuable child, an inactive one-shot sibling, and a persisted grandchild; it expands without activation, opens persisted history, admits a human FIFO follow-up, reconciles child mux events, and proves one-shot history remains read-only.
- Sidebar tests pin `origin: 'subagent'` filtering without hiding ordinary forks.

## Consequences

- Catalog reads may rescan persisted lineage and descriptor logs, so activity uses existing live frames while membership refresh stays debounced and single-flight.
- Parent availability and child activity are process-local snapshots. Publication, disposal, another sender, or another process may win after listing; typed prompt failure remains expected.
- A child may publish between history fetch and mux subscription, so the existing sequence reconciliation also covers the cold-to-live addressed path.
- Persisted origin adds one deliberately weak product-classification field to child headers and list projections; it cannot become an authorization shortcut.
- The UI has no child cancellation, durable outcome, activation duration, deletion, or independently interactive offline mode, and its text must not imply those capabilities.
