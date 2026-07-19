# RFC: Use one surface manager per session

Status: proposed

English | [中文](2026-07-19-use-one-session-surface-manager.zh.md)

## Problem

`Session` maintains two `SurfaceManager` instances over the same append-only event log. `surfaceValidator` eagerly validates seed and append candidates, while the lazy `_surface` independently folds committed events for `session.surface`, derived messages, compaction, and workspace context. Once the public surface is read, every later event advances duplicate node and replacement-generation state.

The [session surface decision](../../implemented/architecture/2026-06-18-session-surface.md) calls for one ordered surface and one representation to validate. The second manager does not create an independent authority or protect a different failure boundary; it repeats the canonical fold and gives the two views a state-drift opportunity.

## Proposal

Keep one `SurfaceManager` per `Session`. Seed and append acceptance continue to call `validateNext()` before committing an event, and the public surface view reads `nodes` and `replaceGeneration` from that same manager.

Expose only the readonly surface contract from `Session.surface`; candidate validation remains owned by `Session`. Retain `foldSurface()` as the detached full-log replay function used by offline validation and reconstruction.

## Implementation plan

1. In `packages/core/session/src/surface.ts`, export a structural `SessionSurface` contract containing only readonly `nodes` and `replaceGeneration`, and make `SurfaceManager` implement it. Re-export that type from `packages/core/session/src/index.ts` so `Session.surface` no longer exposes `validateNext()` through its declaration.
2. In `Session`, replace `surfaceValidator` and lazy `_surface` with one eagerly constructed `surfaceManager`. Route seed and append validation through that manager and return it from `get surface(): SessionSurface`; `deriveMessages()` will read the same nodes and generation. `validateNext()` may synchronize already committed log entries, but it must only plan the uncommitted candidate. The candidate reaches manager state after `log.push()` and the next delta synchronization, so rejection by surface validation or pre-commit `internal/dispatch` cannot leave phantom state.
3. Keep `foldSurface()` and the transition functions in `surface.ts` unchanged. Compile and exercise the direct consumers in `packages/compact/compact/src/tool-pairing.ts`, `packages/compact/compact-basic/src/region.ts`, and `packages/context/workspace-context/src/state.ts`; they continue to consume only nodes and replacement generation.
4. Extend `packages/core/session/tests/surface.spec.ts` to read the public view before an invalid candidate, prove that nodes and generation remain at the accepted prefix after rejection, append a later valid event, and compare every resulting prefix with `foldSurface()`. Add an `internal/dispatch` veto case and a type-level `SessionSurface` assertion in `session.spec.ts`, while retaining the seeded replay, delta-growth, replacement, generation, and derived-cache cases.
5. Run the request-reconstruction, compaction tool-pairing, compaction range, and workspace-context regression suites that consume the surface. In the implementation PR, update `packages/core/session/README.md`, `docs/core-data-structures/session.md`, the implemented session-surface RFC and its Chinese counterpart, the translation record, `scripts/type-equiv.manifest.json`, and the generated RFC index before moving this RFC pair to `implemented/`.

## Alternatives considered

**Keep acceptance and projection state separate.** Separate instances appear to isolate public reads from validation, but ordinary callers already receive borrowed surface state and cannot mutate it through the declared readonly contract. A cast that mutates the returned node array already corrupts derived history; duplicating the manager is not a sound runtime trust boundary.

**Recompute the public surface from the full log on every access.** This removes cached duplicate state but gives up incremental derivation and makes repeated request construction scale with complete session history.

## Acceptance criteria

- A live `Session` owns exactly one incremental `SurfaceManager`.
- Seed and append candidates are validated before publication with no partial surface mutation on rejection.
- `session.surface`, derived messages, compaction, and workspace context observe the same nodes and replacement generation as the acceptance path.
- `foldSurface()` remains available for detached replay and agrees with the live manager for every accepted prefix.
- Session surface, seed, request reconstruction, compaction tool-pairing, and workspace-context tests pass.

## Risks

Sharing one manager makes the readonly borrowed-state contract more important because a hostile cast could corrupt both validation and projection state. The implementation should return a narrowed view and keep mutation methods inaccessible through `Session.surface`; JavaScript callers that deliberately bypass the type contract remain outside the supported same-process boundary.
