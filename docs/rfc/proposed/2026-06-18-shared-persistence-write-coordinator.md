# RFC: Shared persistence write coordinator

Status: proposed

## Problem

`dsh-session-persistence-jsonl` and `dsh-session-persistence-sqlite` intentionally prove the same `SessionPersistence` contract over different storage media, but their write-path orchestration is now duplicated: per-session state, `session/created` adoption, backend-specific prefix reads, write-behind buffers, serialized flush chains, HMR seeding, and dispose drains. The pure seed-prefix collision and serializability guards have already moved into the seam package; the remaining orchestration is still correctness-heavy and already receives the same fixes twice.

## Proposal

Extract a backend-agnostic coordinator into `dsh-session-persistence`. The coordinator owns live-session adoption, buffering, cursor filtering, per-id serialization, and disposal quiescence. Concrete backends provide small hooks for durable operations: create lazy state, find/load stored prefix, append a contiguous batch, update summary, delete, and list.

The public `SessionPersistence` service shape can stay the same. The coordinator can be an internal exported helper or protected base class used by first-party backends; third-party backends may still implement the abstract service directly if their write path is different.

## Acceptance Criteria

- JSONL and SQLite keep passing the existing shared `runPersistenceContract`.
- HMR/adoption/collision tests move to a shared coordinator test suite and run once for each backend through hook-driven fixtures.
- Backend-specific tests focus on storage mechanics only: JSONL path safety/fsync/sidecar behavior and SQLite schema/WAL/transaction behavior.
- A future backend does not need to copy the current `session/event` → buffer → flush orchestration.

## Risks

The current duplication is verbose but explicit. A coordinator must not hide storage-specific durability semantics or make unusual backends fight an inheritance hierarchy. Prefer narrow hooks and contract tests over a large framework.
