# RFC: Shared persistence write coordinator

Status: implemented (proposed and accepted 2026-06-18, implemented 2026-06-20)

## Problem

`dsh-session-persistence-jsonl` and `dsh-session-persistence-sqlite` intentionally prove the same `SessionPersistence` contract over different storage media, but their write-path orchestration was duplicated: per-session state, `session/created` adoption, backend-specific prefix reads, write-behind buffers, serialized flush chains, HMR seeding, and dispose drains. The pure seed-prefix collision and serializability guards had already moved into the seam package; the remaining orchestration was still correctness-heavy and received the same fixes twice. A code-level diff showed the two backends were byte-identical — or same-algorithm — for ALL of it: the four maps (`states`/`buffers`/`chains`/`inits`), `installWritePath`, `initFor`, `onCreated`'s four cases, `flush`, `drain`, `serialize`, `adopt`, `adoptLivePrefix`, `assertVersion`, and the `create`/`append`/`load` skeletons. Only the storage primitives (write bytes vs. INSERT rows) differed.

## Decision

Extract a backend-agnostic `PersistenceCoordinator` into `dsh-session-persistence`. The coordinator owns the orchestration once; each first-party backend composes one (`new PersistenceCoordinator(ctx, this)`), implements a small `PersistenceBackend` hook interface, and delegates its four public service methods (`create`/`append`/`load`/`list`) to it.

Composition, not inheritance. The coordinator is a concrete class the backend holds, not a base class the backend extends. The RFC's risk — "a coordinator must not make unusual backends fight an inheritance hierarchy" — is avoided: a backend exposes only the hooks; it cannot reach the coordinator's private orchestration state, and the public `SessionPersistence` service shape is unchanged, so a third-party backend MAY still implement the abstract service directly without the coordinator at all.

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

The single design choice that keeps the seam clean: the crash-repair "where is the torn tail" token is OPAQUE to the coordinator. The coordinator computes the synthetic closers (it owns `interruptedTurnClosers` from `dsh-session`), but it only ever tests `tornMarker !== undefined` and passes the value straight back to `commitRepair` — it never inspects it. Each backend picks its own marker type: JSONL uses the byte offset to truncate to, SQLite the seq to delete from (both happen to be `number`). The JSONL backend folds its `committedBytes < buffer.byteLength` comparison INSIDE the hook so the returned marker is already `number | undefined`; without that fold the coordinator would have to know about byte lengths.

## Testing

The shared `runPersistenceContract` (public-API contract) keeps running for every backend. A new `runCoordinatorContract` (`tests/coordinator-contract.ts`) holds the write-path orchestration — adoption, HMR, collision, dispose-drain, crash-tail repair — and runs once per backend through a `CoordinatorFixture` (an in-memory reference + jsonl + sqlite). The per-backend specs shrank to storage mechanics only (JSONL: path safety, fsync rollback, bucket listing; SQLite: schema version, `scanRows`, transaction rollback). A through-coordinator torn-tail→load→`commitRepair` test per real backend (via a `corruptTail` fixture hook) keeps the coordinator's torn-marker repair branch covered under the 100% per-file gate — the contract crash test only produces synthetic closers, never a torn marker, so it could not reach that branch.

## Risks and what we gave up

The pre-extraction duplication was verbose but explicit — each backend read top-to-bottom. The coordinator adds one indirection (the hook seam) and one new concept (the opaque torn marker). This clears the bar because the centralized logic is the correctness-heavy part that was already being fixed twice, and the hook set is narrow (six methods, no inheritance). The hook surface was deliberately held to the minimum: the create-collision probe is NOT a separate hook — it folds into `loadStored(id) !== undefined`; there is no separate `materialize` hook (folded into `appendBatch` for atomicity); `list()` stays a backend method with no coordinator pass-through (listing needs none of the orchestration). The net effect is a reduction: one orchestration copy instead of two, the backends shrank by ~1200 lines of duplicated churn, and a future backend implements a handful of small primitives instead of copying the entire `session/event` → buffer → flush machinery.
