# Agent Note: Session projections and command lifecycle logging

Status: proposed

English | [中文](2026-07-27-session-projection-and-command-log.zh.md)

## Problem

Three in-flight web features — todo (#497), goal (#527), and plan mode (#587) — each derive per-session state from the session log and surface it in the browser client, and each invented its own copy of the same machinery:

- **The client core class absorbs every domain.** All three add private fields, fetch choreography, and event switches to the client runtime's `Session` class and project their values through `ConversationSnapshot`. Plan alone adds seven private fields and a three-layer fence (request version, event version, latest-live cache); goal adds a write-revision fence plus a coalesced refetch loop; todo adds a projection field and an event case. A fourth domain means editing the core class a fourth time.
- **Three baseline channels.** Todo rides a `todos` field on the history tail page — computed by `backscanTodos` **inside api-proxy**, business folding living in the carrier; plan adds a dedicated `session.planMode` unary; goal adds `goals.get`. Same problem, three wire shapes.
- **Command results are unrecoverable.** `/goal`, `/plan`, and every other slash command return their outcome only in the `command.execute` RPC response, surfaced as a transient composer notice on the issuing tab. Nothing reaches the session log: a refresh, another tab, resume, or fork loses the record that the command ever ran. The domain *state* changes are durable (goal commits `goal/change` metadata, plan commits `plan/mode`), but the command invocation and its verdict are not.

The underlying gap is architectural: the client has no seam for a plugin to observe session events in a session's scope and keep its own derived state, and the host has no uniform way to hand a client the current value of log-derived state whose history may have been paged out of the client's window.

## Proposal

Four infrastructure pieces, then the domains become pure contributors.

### Whole-value event rule

A state-carrying log event MUST carry the complete post-change state, never a delta. All three domains already comply: `todo/write` is a whole-list snapshot, `plan/mode` a whole boolean, `goal/change` metadata a full `GoalSnapshot` (or a whole-value clear tombstone). Under this rule the client-side fold degenerates to **last-wins**: a domain's state is the whole value carried by the highest-seq domain event seen. No client-side state machine (goal's revision/CAS/phase checks stay at the host write path), no history dependence, out-of-order immunity by seq comparison, and self-healing — a missed event is corrected by the next one.

### Host projection registry (`dsh-session-projection`, new package)

A light interface package: the merge-extensible type map, the registry service, zod at the boundary. Capability-seam three-way split: domain host plugins contribute, carriers consume, neither knows the other.

```ts
export interface SessionProjectionMap {}   // the single type table for the whole chain

export interface ProjectionProvider<K extends keyof SessionProjectionMap> {
  key: K
  schema: ZodType<SessionProjectionMap[K]>  // validates the payload before it leaves the host
  get(agent: Agent): SessionProjectionMap[K] // MUST be synchronous; whole current value
}

declare module 'cordis' {
  interface Context { sessionProjections: SessionProjectionRegistry }
}
```

- Values are wire JSON payloads; the same map typed end to end (host provider, wire block, client cell, React hook) via `import type` — no second DTO table, no separate client-side "views" map. How a value is *rendered* is the slot system's business, never the projection layer's.
- `get` runs against the host's full in-memory log (`agent.session.events`) — pagination exists only in the history slice returned to the client, never in the provider's view, so "the window lacks the event" cannot lose state on the host. A last-wins domain may backscan (bounded: first hit from the tail terminates; the events live in memory); a domain with an expensive fold keeps an incremental cache keyed by observed seq (goal's `GoalCache` is the template). Either way the provider returns the current whole value synchronously.
- Registration is an effect (disposer with the fiber): an unloaded plugin's key disappears from subsequent responses and the client reads it as capability absence — HMR semantics for free. Duplicate keys throw. Domain plugins register under `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry stay unaffected.
- The package owns `./invariant` (every served key has a live registration).

### Wire: projections block on the history tail page

```ts
// session.history response, tail page only (beforeSeq absent):
{ events, hasMore,
  projections?: { asOfSeq: number, values: Partial<SessionProjectionMap> } }
```

The api-proxy history handler, after slicing the tail page, reads `session.seq`, then synchronously walks the registry — no `await` anywhere, so every key's value and `asOfSeq` form one consistent cut, and `asOfSeq` equals the window tail seq. Api-proxy holds zero domain knowledge (the same carrier/contributor relationship as `viewFor` against `ctx.tools`).

No new RPC method. The timing coincidence is exact: every moment the client needs a fresh baseline (open, reconnect resync, gap repair) already pulls the tail page, and the only path that never needs one (loadOlder) is the only path that passes `beforeSeq`. The client therefore has **no** independent "refetch the baseline" decision at all. Window content is never a signal: "no domain event in the window" is unanswerable there by construction, and only the baseline answers it.

Retired by this block: `session.planMode` (read side; `setPlanMode` stays), `goals.get` (read side; the six mutation RPCs stay, their responses no longer feed state — the mux event arrives anyway), the `todos` rider field, and `backscanTodos` in api-proxy (moves into the todo domain's provider, in `tool-todo`).

### Client: session-scope event dispatch and projection cells

The client runtime `Session` object gains a dispatch seam at its two event entrances — `appendLive(event)` (live signal) and `installWindow(…)` (window-replace signal, plus baseline reset when the response carries a projections block). Live and window-replace are distinguishable signals: that distinction is what #527 hand-rolled to avoid refetch storms and #587 hand-rolled to re-scan replacement windows. The core class returns to pure transcript concerns; the domain switches leave `applyEventSideEffects`.

Domain client plugins register **projection cells** at scope materialization (the `InputHub.shellFor` pattern; teardown rides the scope fiber):

```ts
export interface ProjectionCellSpec<K extends keyof SessionProjectionMap> {
  key: K
  schema: ZodType<SessionProjectionMap[K]>   // validates the baseline at the wire boundary
  fromEvent(event: SessionEvent): SessionProjectionMap[K] | undefined  // whole value, or not-my-event
}
```

Framework semantics, implemented once for all cells: a `lastAppliedSeq` watermark initialized from the baseline's `asOfSeq`; one application rule — `event.seq > watermark` and `fromEvent` hit ⇒ take the whole value, raise the watermark, `markDirty` (Notifier batching); live and window-replace events pass the same filter, so replayed old pages are dropped by seq and can never roll state back; a baseline reset re-seeds value and watermark, and a key absent from the block marks the capability absent. All the per-domain fences (#587's three layers, #527's write revision) dissolve into this one seq rule. Plan's pending intent stays out of the log (turn-enclosure) but inside the projection value — the host's `planMode.get()` already returns exactly that shape; pending is not propagated to other tabs (accepted: it is the issuing tab's local "awaiting boundary" fact; other tabs see the commit event).

### React: `useProjection`, the fifth framework hook seat

The existing four seats cannot host this state (store discipline bans business objects; inject bans hooks; `ConversationSnapshot` is being evacuated). `useProjection` becomes a framework seat, minted in web-react (the one hook constructor), delivered through the same standard-kit channel as `useSession` (`provideInfo` → SessionProvider → props):

```ts
type UseProjection = {
  <K extends keyof SessionProjectionMap>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap, S>(
    key: K, selector: (v: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean): S
}
```

`undefined` uniformly means capability absent (host plugin unmounted, client plugin unmounted, or baseline not yet landed). Cells expose bare `{subscribe, getSnapshot}`; `bindSnapshotSelector` with per-cell caching does the rest — reference stability holds because whole values are frozen event data, identical between events. Write paths are unchanged: mutation callbacks stay in the inject share (callbacks out of inject, live state out of `useProjection`).

The one existing violation of "no hooks through inject" — `DetailsInjected.useSelection` — is folded in with this change: selection is viewing state living in the chat store, so the details registration declares the shared store handle and the component reads `props.useStore(s => s.selection)`; `useSelection` leaves the inject contract.

### Command lifecycle in the log

Two log-only (non-surface, model-invisible) events, mirroring the `tool/call`/`tool/result` pairing:

```ts
'command/run':  { commandId: string; name: string; line: string; source: CommandSource }
'command/done': { commandId: string; kind: 'success' | 'error'; text?: string }
```

Both merged into `OutOfBandSessionEventMap`. The host command executor (`packages/ui/commands`) appends `command/run` before invoking the handler and `command/done` at settlement. `text` is the handler's verbatim outcome — factual data of the same nature as `tool/result.content`, not presentation (how it is laid out remains client-computed at render time, satisfying the "presentation never enters the log" red line). Domains that want the model to know the outcome keep doing what they do today (plan's narration, goal's inject) — that is a domain decision, unchanged.

Because committed events broadcast on the mux stream, refresh persistence, multi-tab sync, and fork/resume recovery all come for free. The `command.execute` RPC degrades to pure admission (matched or not, syntax errors back to the composer immediately); the one-shot notice channel (`runDetached` → `noticeFor`) is retired.

The client flow builder gains one generic command node (run/done paired by `commandId`; cross-window cuts soft-fall like tool pairs). Rendering goes through a new keyed slot `'conversation.chat.commandview'`, key = command name, **fallback = a generic command card** (zero registration required — the former notice text now renders durably in the flow). A domain upgrades by registering one row component, drawing on `command/run.line` and its own cell state — the same shape as tool rows after the toolview dissolution.

## Delivery plan

Infrastructure first; the three in-flight PRs are left untouched and re-target after the base lands (their migration mapping is the guide):

1. **Host base**: `dsh-session-projection` + api-proxy projections block. Mergeable with zero domains registered (block simply absent).
2. **Client base**: dispatch seam + cell framework + `useProjection` seat + the `useSelection` fold-in. Parallel with 1 (fixtures feed synthetic baselines).
3. **Command channel**: the two events, executor logging, generic node + keyed slot, notice retirement. Parallel with 1.
4. **Domain re-targets** (after 1+2): todo first (smallest: provider in `tool-todo`, cell from `todo/write`, drop the rider field), then plan (drop the unary and the fences), then goal (drop `goals.get`, move the six `Session` methods into the domain plugin's inject).

## Alternatives considered

**A dedicated `session.projections` RPC** — rejected: baseline-refresh moments coincide exactly with tail-page pulls, so a separate unary buys a second round-trip, a second seq to reconcile, and a client-side "when to refetch" decision that the rider design deletes outright.

**Naming the seam `registerFold`** — rejected: `get` does not promise a fold (goal reads a cache, plan overlays un-logged pending intent from service memory); `fold*` in this repo names pure `(events) => state` functions and the registry would dilute that. Projection is the event-sourcing term for exactly this read-model role, and both #587's note title and #497's comments already use it.

**An `invalidate`-style cell (mark dirty, refetch on domain events)** — rejected: it exists only to serve delta events. The whole-value rule makes every domain last-wins; goal's refetch loop, its coalescing, and its stale-read fence all disappear.

**Hanging the registry off `ctx.apiProxy`** — rejected: session projections are not web-specific (TUI, ACP, headless are future consumers), and domain packages must not depend on the apiproxy package. The independent seam also deletes #587's type-only import edge from api-proxy into the plan package.

**A separate client-side `SessionProjectionViews` type table** — rejected: one `SessionProjectionMap` typed end to end is the wire-passthrough discipline (no second DTO vocabulary); values are JSON payloads and rendering belongs to slots.

**Event-broadcast collection instead of a registry walk** — rejected: async listeners cannot yield the single synchronous cut that makes `asOfSeq` one consistent snapshot across all keys; registries are this repo's shape for contributions (`ctx.tools`, prompt sections, slots).

**Propagating plan's pending intent across tabs** — deferred, not designed in: pending is deliberately un-logged (turn enclosure), a live non-logged control frame (the `session/queued` precedent) can add it later without touching this model.

**Making mutation RPC responses feed cell state** — rejected: the committed mux event arrives immediately and carries the same whole value with a seq; responses feeding state is what required #527's write-revision fence.

## Acceptance criteria

- A domain plugin ships per-session log-derived state to React by writing only: the whole-value event declaration, one host `register`, one client cell registration, and inject callbacks — no edits to the client `Session` class, `ConversationSnapshot`, api-proxy, or the wire schema files beyond its own `SessionProjectionMap` merge.
- The history tail page carries `projections` with `asOfSeq` equal to the window tail seq; loadOlder pages never carry it; a deployment without the registry serves histories without the block and clients treat every key as absent.
- Replayed window events cannot regress cell state (watermark test); a baseline landing after a newer mux commit cannot overwrite it (seq rule test).
- A slash command executed on one tab renders a durable node in the flow on refresh, on a second tab, and after resume; unregistered commands render the generic card; the composer notice path for command outcomes is gone.
- `useProjection` reaches components through the standard props kit; no hook crosses an inject contract (including `useSelection`).

## Risks

- **Whole-value rule is load-bearing**: a future domain logging deltas breaks last-wins silently. Mitigation: the rule is stated here and in the projection package README; cell `fromEvent` signatures make delta shapes unrepresentable without deliberate effort.
- **Synchronous `get` discipline**: a provider that awaits would tear the consistency cut. The registry documents and the invariant companion asserts synchronicity as far as practical; review owns the rest.
- **Projection payload growth**: every tail page carries every registered key. Payloads are whole values of UI-scale state (a todo list, a goal snapshot); if a future domain's value is large, per-key opt-out or lazy keys can be added to the request without changing the model.
- **Command log volume**: two log-only events per slash command; bounded by human command frequency, negligible against chunk volume.
- **Re-target churn**: three open PRs rebase onto a moved foundation. Accepted cost of infrastructure-first; the migration mapping section in the design ledger names each PR's keep/drop list.
