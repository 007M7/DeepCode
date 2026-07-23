# Agent Note: Shared persistence write coordinator

Status: implemented

## Problem

`dsh-session-persistence-jsonl` and `dsh-session-persistence-sqlite` intentionally prove the same `SessionPersistence` contract over different storage media, but their write-path orchestration was duplicated: per-session state, `session/created` adoption, backend-specific prefix reads, write-behind control, per-id operation serialization, HMR seeding, and dispose drains. The pure seed-prefix collision and serializability guards had already moved into the seam package; the remaining orchestration was still correctness-heavy and received the same fixes twice. Only the storage primitives (write bytes vs. INSERT rows) differed.

## Decision

Extract a backend-agnostic `PersistenceCoordinator` into `dsh-session-persistence`. The coordinator owns the orchestration once; each first-party backend composes one (`new PersistenceCoordinator(ctx, this)`), implements a small `PersistenceBackend` hook interface, and delegates its four public service methods (`create`/`append`/`load`/`list`) to it.

Composition, not inheritance. The coordinator is a concrete class the backend holds, not a base class the backend extends. The Agent Note's risk — "a coordinator must not make unusual backends fight an inheritance hierarchy" — is avoided: a backend exposes only the hooks; it cannot reach the coordinator's private orchestration state, and the public `SessionPersistence` service shape is unchanged, so a third-party backend MAY still implement the abstract service directly without the coordinator at all.

The coordinator holds one controller for each exact live `Session`; the controller combines initialization, pending events, and the shared flush promise. Each `session/event` starts an eager drain, and `session/flush` observes quiescence rather than initiating the ordinary write path. The [flush-controller simplification](../simplification/2026-07-23-collapse-persistence-flush-state.md) owns this lifecycle.

The coordinator retires a session from `session/disposed`: it waits for the controller's initialization and current flush, serializes a final drain, and removes the controller and owned per-id state only after success. A failure leaves the controller discoverable for backend teardown to retry. Settled per-id chain tails remove themselves only when they are still current, so a completion cannot erase a newer operation for the same id. Backend teardown unregisters write-path listeners, flushes every remaining controller, awaits per-id operations, and then closes the backend.

### The hook interface (`PersistenceBackend<TornMarker>`)

Six methods (five required + an optional lifecycle hook) — the only seam between the coordinator and storage:

- `name` — backend label for the dispose-failure `AggregateError`.
- `loadStored(id)` — read a stored prefix by id, scanning ANY storage scope (every JSONL cwd bucket; SQLite's id is globally unique). Used by resume/load and, via `!== undefined`, the create-collision probe.
- `loadLive(id, cwd)` — read a stored prefix SCOPED to `cwd`. **Deliberately distinct from `loadStored`**: HMR live-adoption must only adopt a persisted log at the SAME cwd as the live session; a same-id log at a different cwd is a collision, not a resume. Collapsing the two reintroduces a cross-cwd adoption bug. SQLite ignores `cwd`.
- `appendBatch(meta, events, isMaterialized)` — durably append a contiguous batch, lazily materializing the session ATOMICALLY when not yet materialized (the materialize-write and the first event batch must commit together — a crash between them must not leave a materialized-but-empty session; this is why there is no separate `materialize` hook).
- `commitRepair(meta, tornMarker, closers)` — make a crash repair durable: truncate the torn tail (iff `tornMarker !== undefined`) and append `closers`. **NOT required to be atomic** — JSONL legitimately truncates-then-appends in two fsync'd steps, SQLite does DELETE+INSERT in one transaction. Used by `load` (truncate + synthetic closers) and live-adoption (truncate only, `closers = []`).
- `list()` — list all stored metadata.
- `close?()` — optional lifecycle teardown (SQLite closes its db handle; JSONL omits it), awaited in the dispose effect AFTER the quiescence drain so a close failure never masks a drain error.

### The opaque torn marker

The single design choice that keeps the seam clean: the crash-repair "where is the torn tail" token is OPAQUE to the coordinator. The coordinator computes the synthetic closers (it owns `interruptedTurnClosers` from `dsh-session`), but it only ever tests `tornMarker !== undefined` and passes the value straight back to `commitRepair` — it never inspects it. Each backend picks its own marker type: JSONL carries the byte offset to truncate to plus any complete events decoded from an incomplete final frame, while SQLite carries the seq to delete from. The coordinator therefore knows neither byte lengths nor frame recovery state.

## Testing

The shared `runPersistenceContract` (public-API contract) runs for every backend. `runCoordinatorContract` (`tests/coordinator-contract.ts`) covers adoption, HMR, collision, disposal drains, and crash-tail repair through an in-memory reference, JSONL, and SQLite. Coordinator-specific tests cover eager follow-up batches, live-controller cleanup, same-id chain-tail races, failed-drain retry, and close ordering. The per-backend specs retain storage mechanics only. A through-coordinator torn-tail repair test per real backend keeps the opaque-marker branch covered.

## Alternatives considered

- **A base class the backends extend** — rejected for composition: a backend exposes only the hooks, cannot reach the coordinator's private orchestration state, and a third-party backend may still implement the abstract service directly without the coordinator at all.
- **A wider hook surface** — each candidate hook folded away: there is no separate `materialize` hook (the materialize-write must commit atomically with the first event batch inside `appendBatch`), no separate create-collision probe (it is `loadStored(id) !== undefined`), and no coordinator pass-through for `list()` (listing needs none of the orchestration).

## Consequences

The coordinator adds one indirection and an opaque torn marker, but centralizes correctness-heavy orchestration previously duplicated by every backend. Session disposal remains an observe-only event, so the coordinator contains retirement failures, preserves pending events in the live controller, and makes backend teardown the final quiescence boundary. Its hook surface stays narrow: collision checks reuse `loadStored`, materialization stays atomic inside `appendBatch`, and listing bypasses the coordinator. New backends implement storage primitives rather than copy the write lifecycle.
