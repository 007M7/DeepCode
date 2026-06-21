# RFC: Prune dead methods from the persistence seam

Status: implemented (proposed and accepted 2026-06-20)

> **Decision (scope: persistence only).** The shipped change removes the two dead persistence methods `SessionPersistence.has()` and `.delete()`; the body below records that decision. The bash seam's `BashExecutor.get()`/`.list()` were **considered for the same treatment and deliberately kept**: each is a one-line accessor over the executor's already-tracked `tasks` map, and removing them would force `dsh-tool-bash`'s tests onto a ~35-line `onTaskDone`-based completion-tracking harness to replace the one-line `ctx.bash.get(id)` lookup — the migration cost dwarfs the surface removed. Per the [AGENTS.md "RFCs are proposals, not golden truth"](../../../../AGENTS.md) principle, that friction is evidence the method earns its keep: a test harness IS a consumer that programs against the seam, so `get()`/`list()` stay. (`BashTaskId`-branding those surviving methods is taken up by the [branded-ids RFC](../../proposed/architecture/2026-06-20-branded-ids.md).) The persistence removal carries no such cost: `has()`/`delete()` had only contract-test callers and no test-ergonomics consumer to migrate.

## Problem

A capability seam ([interface / implementation / consumer](../../implemented/architecture/2026-06-13-capability-seams.md)) carries abstract methods that no consumer calls. The seam exists to let implementations and consumers evolve independently — but a method no consumer programs against is not a seam, it is speculative surface every implementation must still implement and test.

### `SessionPersistence.has()` and `.delete()`

The abstract service declared its operations beyond create/append: `load`, `list`, `has`, `delete`. Production consumers of `ctx.sessionPersistence` use only two: the agent-loop resume path calls `load()` ([packages/core/agent-loop/src/index.ts:176](../../../../packages/core/agent-loop/src/index.ts)), and the ACP bridge calls `list()` for `session/list` ([packages/ui/acp/src/index.ts:494](../../../../packages/ui/acp/src/index.ts)). Grepping every `sessionPersistence.*` / `persistence.*` use across `packages/*/src` and `examples/` finds no `has(` and no `delete(` on the service. The `.has(`/`.delete(` calls in `packages/ui/acp/src/index.ts` are on the in-memory `SessionStore` and a local `Set` of loading ids, not persistence. The only callers of `has`/`delete` were the contract suites and per-backend specs.

`has()` was not just unused — it was the most intricate branch in the shared coordinator: a tracked-vs-untracked dual-probe (`loadLive(id, cwd)` for a live-tracked session vs `loadStored(id)` for an untracked one) with a multi-line rationale. `delete()` dragged the `deleteStored` backend hook that every backend had to implement. This is the [drop-mutable-session-summary](../../implemented/simplification/2026-06-19-drop-mutable-session-summary.md) pattern: a contract test exercised both, but no shipping code asks "is this session persisted?" or removes one.

## Proposal

Remove the methods nothing consumes, from the abstract seam, the implementation, and the contract/spec suites that exist only to exercise them:

- `SessionPersistence.has()` / `.delete()`: delete the abstract declarations, the coordinator's `has`/`delete`/`deleteCore`, and the `PersistenceBackend.deleteStored` hook. Remove the `has`/`delete` rows from the contract suite and the per-backend specs (jsonl + sqlite each implemented `deleteStored` only to satisfy the hook — that implementation goes too). The backends are the [dual-backend](../../implemented/architecture/2026-06-14-session-persistence.md) design and otherwise out of scope, but removing a hook they implement for no consumer is part of removing the hook, not a backend redesign.
- Update every doc and source-comment reference to the removed methods — not only literal `has(`/`delete(`/`deleteStored` call spellings, but also `{@link has}`/`{@link delete}` JSDoc links and prose that counts the methods (removing 2 of the persistence service's 6 public methods makes any "six public methods" phrasing wrong). The implementing PR greps `has`/`delete`/`deleteStored`/`{@link `/`six ` across `docs/`, `packages/*/README.md`, and source comments, and fixes each. The known doc sites: the seam README ([packages/session-persistence/session-persistence/README.md](../../../../packages/session-persistence/session-persistence/README.md)'s `has(id)`/`delete(id)` API row and its "delegates its six public service methods" prose → four), the backend READMEs that describe `has`/`list` semantics ([packages/session-persistence/session-persistence-sqlite/README.md](../../../../packages/session-persistence/session-persistence-sqlite/README.md), [packages/session-persistence/session-persistence-jsonl/README.md](../../../../packages/session-persistence/session-persistence-jsonl/README.md) — reword "absent from `has()`/`list()`" to just `list()`), the service-map / seam docs in [docs/architecture.md](../../../architecture.md), and the persistence prose in the [session-persistence RFC](../../implemented/architecture/2026-06-14-session-persistence.md) and [shared write-coordinator RFC](../../implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md). The known source-comment sites: the abstract `create()` JSDoc's `{@link has}/{@link list}` link ([packages/session-persistence/session-persistence/src/index.ts](../../../../packages/session-persistence/session-persistence/src/index.ts) — drop the `has` link), the coordinator's "six public methods"/"six public service methods" module + class JSDoc and its lazy-materialization JSDoc justifying the `materialized` flag by "the signal `has`/`list` rely on" ([packages/session-persistence/session-persistence/src/coordinator.ts](../../../../packages/session-persistence/session-persistence/src/coordinator.ts)), the JSONL backend's `loadStored`/`deleteStored` comment, and the SQLite backend's `schema.ts` and `index.ts` comments that mention "absent from `has`/`list`" — all reworded to the surviving four-method, `list()`-only contract.

## Why not keep them as "the seam should be complete"?

The instinct that a persistence seam "should" offer delete is real — and it is exactly the speculative-completeness the pre-release stance warns against ([AGENTS.md](../../../../AGENTS.md): optimize for the correct foundation, not for hypothetical callers you do not have). `delete()` is one method to re-add the day a consumer needs it: a session-management UI that deletes old sessions will want it — add it then, designed against that UI's real needs (soft-delete? cascade? confirmation?), not guessed now.

Re-adding a seam method with a live consumer is cheap and better-designed than the speculative version, because the consumer pins the contract. Carrying it unused means every implementation (and every future backend) must implement and test a method that does nothing.

## Acceptance criteria

- `has`/`delete`/`deleteStored` are gone from the persistence seam, impl, and contract suites; `pnpm run knip` reports no new dead exports.
- The remaining persistence operations (`create`/`append`/`load`/`list`) are untouched; ACP `session/list` and crash-recovery behave identically.
- `pnpm run test:coverage` stays 100% per-file (the contract/spec rows for the removed persistence methods are deleted with them).
- The persistence seam README and `docs/architecture.md` no longer list the removed `has`/`delete` methods.

## Risks

- **`delete()` is the kind of operation a product eventually wants.** True — but "eventually" is the point. Deleting it now and re-adding it against a real consumer is strictly better than shipping a guessed contract. The dual backends each shed a `deleteStored` impl, which is a bounded edit in otherwise-out-of-scope packages.
- **Low coupling.** The removal is confined to the persistence seam + impl + tests; no cross-package consumer references the removed methods, so there is no ripple beyond the docs.

Modest size, but it converts the seam from "what an implementation must provide for nobody" back to "exactly what a consumer uses."
