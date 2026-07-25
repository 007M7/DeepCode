# Agent Note: Workspace GUI and session drafts

Status: proposed

English | [中文](2026-07-25-workspace-gui-and-session-drafts.zh.md)

## Problem

[Domain KV storage and the Workspace entity](../architecture/2026-07-24-domain-kv-storage-and-workspace.md) define the persistent Workspace entity, path conventions, and ordered session ledger, but do not define Host wiring, historical-data initialization, or GUI flows. The GUI displays Workspaces and Sessions together, and users must be able to type immediately after entering the New Session page, even when no real Session or even real Workspace exists yet.

Using one intent to represent both a pending Workspace and a pending Session would make explicit Create Workspace actions, the automatic empty state, sidebar draft rows, and first-send failures share an ambiguous state. Creating a Host Session in advance to support the empty state would instead produce an empty Session with no user input, no persisted data before its first event, and no survival across restarts. Existing historical Sessions also expose only `SessionHeader.cwd`, so the system needs to build an initial Workspace view without reading event bodies.

## Proposal

### State and ownership

Workspace and Session are two real Host objects; WorkspaceDraft and SessionDraft are two page-local Client states:

- A `Workspace` can be empty, persists durably, and always appears in the sidebar;
- A `Session` is a real object already created by the Host;
- A `WorkspaceDraft` exists only for the automatic empty state when the system has no Workspace at all and does not appear in the sidebar;
- A `SessionDraft` represents a pending Session and holds its target Workspace or WorkspaceDraft, preallocated SessionId, composer content, and send phase.

At most one SessionDraft exists on a page. A draft under a real Workspace appears in the sidebar as “New session”; neither a WorkspaceDraft nor its SessionDraft appears there. A new draft replaces the old one; selecting a real Session or refreshing the page discards any unmaterialized draft and uncommitted input. Real Workspaces, real Sessions, and messages already accepted by the Host are unaffected.

The Client represents the current page with the discriminated union `ConversationStage = Session | SessionDraft` instead of simulating a draft by clearing current and storing an intent elsewhere. Workspace, Session, and ConversationStage are separate object layers; only a real Session selection can be persisted.

### End-to-end Host and wire flow

The Host exposes the following GUI wiring over the existing Workspace entity:

| RPC | Behavior |
| --- | --- |
| `workspace.list` | Returns real Workspaces in a stable order and filters out session ids that fail header validation |
| `workspace.create({ name })` | Creates a directory at `workspaceRoot/name` and a Workspace when the name is available; duplicate-name requests fail |
| `workspace.create({ path })` | Adopts an existing directory without creating directories for arbitrary input paths |
| `session.create({ workspaceId, sessionId? })` | Resolves cwd from the Workspace, idempotently creates a real Session with an optional preallocated id, and attaches it |
| `session.create({ cwd })` | Remains available to non-GUI callers and creates an Ungrouped Session |

`workspaceRoot` is an independent Host configuration that falls back to the Host cwd when unset; it is unrelated to the `storageRoot` that stores Workspace domain data. The Host stream pushes incremental Workspace and Session updates, while reconnection uses `workspace.list` and `session.list` as its two baselines.

The GUI preallocates a SessionId in SessionDraft but creates no Host intent before the first send. On the first send, the Client passes that id to `session.create`; the Host uses the same id to create both the real Session and its persistence create-intent. Retrying the same id with the same cwd is idempotent; an existing id with a different cwd fails loudly. This lets a lost response or partial attach failure reconcile to the same Session instead of creating a duplicate.

A Workspace's `sessionIds` is an ordered candidate index. A Session is a member only when its id is present in the index and its canonicalized `SessionHeader.cwd` equals the Workspace path; SessionHeader does not gain a `workspaceId`. A Session whose cwd matches but whose id is absent from the index remains Ungrouped, while an indexed id with a missing header or mismatched cwd does not enter the projection. A Session appearing in two Workspace indexes is corrupt state and fails loudly.

### One-time historical initialization

The Workspace domain uses a durable marker to distinguish “never initialized” from “initialized but empty.” When the marker is absent, WorkspaceRegistry performs a reentrant bootstrap once:

1. Call `SessionPersistence.list()` exactly once; JSONL reads only the first header line, SQLite reads only session metadata rows, and the bootstrap must not call `load`, `inspect`, history APIs, or parse event bodies.
2. Ignore headers with no cwd, a nonexistent path, a path that is not a directory, or a failed realpath lookup; these Sessions remain Ungrouped.
3. Group by canonical cwd, sort each group by header `createdAt` in descending order before writing `sessionIds`, and order Workspace groups stably by each group's maximum `createdAt`, also descending.
4. After a crash, reentry reuses Workspaces already written for the same canonical path and merges missing ids; write the marker last, after all records are durable.

After the marker is written, the system no longer creates Workspaces or backfills their ledgers automatically from cwd. Subsequent call paths that omit `workspaceId` remain Ungrouped; this is a compatibility path, not a second source that continuously derives Workspaces.

### User flows

On initial entry, the Client waits until both Workspace and Session baselines are ready; it restores a still-existing real Session selection when possible and otherwise enters the New Session flow. When the user explicitly enters New Session, the Client does not restore the old selection: it selects the most recent Workspace and creates a SessionDraft. The most recent Workspace is determined by the maximum `updatedAt` among its validated member Sessions, with an empty Workspace falling back to `createdAt`. This value only chooses the default target for New Session; it neither changes the sidebar Workspace order nor triggers a second selection after the Session list arrives.

When no Workspace exists at all, the page creates a WorkspaceDraft named `workspace` and its SessionDraft. Neither is written to the Host, but the composer always remains editable. The top-level New Session action reenters this empty-state selection flow without calling `session.create` immediately.

The plus button in the Sidebar Workspace section header and the Workspace creation entry in the composer reuse the same picker and modal:

- Select an existing Workspace: create only a SessionDraft targeting that Workspace;
- Use an existing folder: call `workspace.create({ path })`, then create a SessionDraft under it after success;
- Create new: use one input as both the directory name and title; the UI disables confirmation when an existing Workspace has that title, and the Host rejects duplicate-name requests caused by bypassing the UI or concurrent creation; after success, create a SessionDraft under it.

Explicit Create Workspace creates a real Workspace as soon as the user confirms and immediately displays it in the sidebar; the empty Workspace remains even if the user never sends a message. The inline plus button on a Workspace row creates only a SessionDraft under that group: it neither creates another Workspace nor immediately creates a Host Session.

Sending the first message performs these steps in order: create the Workspace when necessary, create the Session with the preallocated id, hand the stage and composer buffer off to the real Session, and call `session.prompt`. The Client clears the input only after the Host accepts the prompt. A Workspace remains if failure occurs after it is created; a real Session remains selected if failure occurs after it is published; a prompt failure retains the original input and retries the same Session.

### Sidebar and ordering

Workspace groups use the persistent stable order returned by the Host. Bootstrap establishes the historical order once, and explicitly created Workspaces go first; Session activity never moves Workspace groups.

Within a group, Sessions render strictly in `Workspace.sessionIds` order. Historical Sessions are initialized from the header `createdAt`, and new Sessions go first; whenever a Session's `updatedAt` advances afterward, the Host moves only that id to the front of its Workspace and persists the change. The Client does not batch-sort by `updatedAt` after Session list hydration, so the page never displays the bootstrap order and then jumps as a whole.

SessionDraft is a presentation-layer row appended without writing to `sessionIds`. When a real Workspace has a SessionDraft, the sidebar's page-derived session count temporarily increases by one; once the real Session with the same id appears, it must not be counted twice, and refreshing removes both the draft and its temporary count. `host/session-added` and `host/workspace-changed` may arrive in either order; the Client merges them by the preallocated SessionId and removes the draft once the real row can be located, without ever briefly showing two rows with the same id.

### Client and UI boundaries

A dedicated WorkspacesService manages the Workspace list phase, incremental upserts, reconnect refresh, creation, and recent-Workspace derivation. SessionsService manages only the real Session list, Session scope, history, running state, and real selection. A page-local conversation coordinator manages ConversationStage, SessionDraft, materialization phase, errors, and composer-buffer handoff.

The existing sidebar layout, row styles, EmptyHero, composer styles, Menu/Modal/Tooltip, portal and slot infrastructure, and `ui-workspace` component skeleton can remain. The Workspace/Session state boundary, empty state, creation actions, first-send state machine, historical initialization, and component props need to be rewritten. The Sidebar and conversation-empty entry points must use the same Workspace data and creation actions; only their anchor direction, open state, and selection callback may differ.

This phase uses English UI text and does not provide Workspace rename/delete, Session delete, cross-Workspace moves, drag ordering, manual adoption from Ungrouped, multiple SessionDrafts, draft restoration after refresh, or separate display-name and directory-name inputs.

## Alternatives considered

**Continue deriving Workspaces dynamically from cwd.** This cannot represent empty Workspaces, stable display names, or explicit order, and it would automatically adopt non-GUI Sessions. Derivation is allowed only for the one-time historical bootstrap; ownership must subsequently be written explicitly to the index.

**Use one WorkspaceIntent to represent both WorkspaceDraft and SessionDraft.** Their visibility, persistence, and materialization timing differ. Combining them prevents explicit Create Workspace from taking effect immediately and prevents the sidebar from distinguishing a hidden WorkspaceDraft from a draft row under a real Workspace.

**Create a Host Session or Host persistence intent immediately for the empty state.** A Session with no input would enter the Host lifecycle, while refresh semantics would conflict with a page-local draft. Only a Client SessionDraft exists before the first send.

**Delay explicit Create Workspace until the first send.** The sidebar would still have no real empty Workspace after user confirmation, conflating “Create Workspace” with “prepare Session.” Only the automatic no-Workspace empty state allows delayed creation.

**Batch-reorder on the Client by updatedAt after the Session list arrives.** The page would first show the bootstrap `createdAt` order and then jump as a whole, while reconnection could not restore the same order. The Host moves only the corresponding id when an individual Session becomes active.

**Add workspaceId to SessionHeader.** This would create two persistent ownership fields alongside the Workspace index and require dual writes. The header retains the Session's own cwd fact, the Workspace index owns explicit membership, and reads validate both directions.

## Acceptance criteria

- Explicit Create Workspace immediately creates and displays an empty Workspace; the automatic empty state with no Workspace writes nothing to the Host and remains editable.
- New Session, selecting an existing Workspace, both Workspace creation methods, and the inline plus button on a Workspace row each produce the single SessionDraft and follow the sidebar visibility rules.
- The first send materializes Workspace, Session, and prompt in that order; successful stages are not rolled back, input is retained until the prompt is accepted, and retries use the same SessionId.
- The Workspace list performs one reentrant bootstrap using headers only; tests prove it never reads event bodies and that an initialized empty registry does not repeat the bootstrap after restart.
- Membership reads validate both the index and header cwd; cwd-only Sessions, invalid historical cwd values, and failed attaches become Ungrouped.
- Initial rendering waits for both baselines to be ready; Session activity does not move Workspace groups, arrival of the Session list does not trigger a full reorder, and activity in one Session moves only that Session to the front and preserves the order across reconnection.
- Workspace and Session updates arriving in either order never create duplicate Session rows; every first-send failure stage can recover to the same preallocated id.
- Create new rejects duplicate Workspace names at both the UI and Host layers; a SessionDraft under a real Workspace temporarily counts toward the sidebar total, and neither materialization nor refresh leaves a duplicate count.
- Real runnable keyless snapshots cover the empty state, explicit creation, successful first send, failed first send, refresh, and Ungrouped; package-level tests cover bootstrap, bidirectional membership validation, ordering, and idempotency.

## Risks

- Header-only bootstrap has no historical activity time and can initialize order only from `createdAt`; it does not batch-correct from the Session list afterward, and only new activity in individual Sessions progressively changes in-group order.
- Historical Sessions with a missing cwd or a path that cannot be resolved by realpath remain Ungrouped; this phase has no manual adoption entry point.
- Refreshing the page discards WorkspaceDraft, SessionDraft, and input not yet accepted by the Host; this is the page-local contract.
- Before its first event, a Host Session still has only a live object and a persistence create-intent; restarting the Host loses that empty Session. This design does not change the existing lazy-persistence semantics by persisting page drafts.
- Explicit Create Workspace persists immediately, so leaving without sending a message still leaves an empty Workspace; this is the cost of making the operation take effect immediately.
