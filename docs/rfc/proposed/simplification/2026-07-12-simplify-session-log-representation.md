# RFC: Simplify session-log representation

Status: proposed

## Problem

The session log maintains two representations that cost more machinery than their consumers require: a pseudo-linked surface and custom request-header deltas.

`SurfaceManager` stores the same order in an array, a seq map, and mutable `prev`/`next` links. Production never reads `prev`; compact's sole `next` read is the successor of an array position. Replacement already uses `indexOf`, so the links do not make its dominant operation constant-time. A seq array with linear replacement lookup has the same asymptotic replacement cost and one representation to validate.

The request-header subsystem implements a custom system/tool delta codec and transmission-decision layer even though its contract says deltas are an encoding optimization, not a reconstructability requirement. Retaining the initial/resume full snapshot at each loop-instance boundary, then writing a canonical full `request/header` whenever that instance's assembled header changes, preserves replay while deleting `SystemDelta`, `ToolsDelta`, round-trip fallback, and the durable `request/header-delta` variant. Codec-only vocabulary disappears with the codec, not because its individual arms were invalid.

This proposal deliberately retains append and replacement `sourceEventSeqs`, crash-repair provenance, and all `SessionStartSource` variants: implemented RFCs give those fields an audit/interception role that zero current readers does not overturn.

## Proposal

Make `SurfaceManager.nodes` a `readonly number[]` of event sequences and remove the public `SurfaceNode` shape. Keep the internal replace-generation signal; update tool-pairing balance and compaction callers to use array values/indices for predecessor, successor, and replacement ranges, removing node links and the seq-to-node map. Replace post-anchor header deltas with canonical full changed-header snapshots and remove the delta codec/event/tests; initial and resume anchors remain full snapshots even when the folded header is unchanged.

Amend the session-surface and reconstructable-request RFCs where they describe the removed encoding. Update event types/invariants, request logging/replay, persistence fixtures, generated catalogs, package docs, and snapshots. Replace the codec-only `fallback` reason with an explicit `change` reason for post-anchor full snapshots, distinguishing them from the retained `initial` and `resume` anchors.

`SESSION_FORMAT_VERSION` is deliberately pinned at `0`, so an old v0 log containing `request/header-delta` would otherwise pass the version check and silently lose header changes after the delta fold is deleted. Seed/load validation must reject that legacy event fail-loud at the format boundary; no compatibility fold or migration is added.

## Alternatives considered

**Keep linked nodes and compact deltas for possible scale.** Links could help a future cursor API, and deltas can reduce logs when large tool schemas change by a small amount. No shipped cursor uses the links, while full snapshots trade disk size for substantially simpler correctness. If header volume proves material, compression or a measured canonical-delta scheme can be designed around real traces.

## Acceptance criteria

- `SurfaceManager.nodes` is one ordered seq array with no `SurfaceNode`, link fields, or seq-to-node map; incremental append processing and the internal replace-generation signal remain.
- Replaying full changed-header snapshots reconstructs exactly the same requests; no header-delta event/type/codec remains.
- A v0 seed or persisted log containing legacy `request/header-delta` is rejected before replay, with coverage for JSONL and SQLite load paths.
- New-shape v0 JSONL/SQLite replay, provenance, crash repair, compaction, snapshots, invariants, typecheck, coverage, doc-sync, build, and hygiene pass.

## Risks

Full headers increase log volume, and linear replacement lookup could be slower on very large surfaces. Replacements are already linear because the implementation calls `indexOf`; benchmarks should be added only if real traces show the simpler array is a bottleneck. Because the format version remains `0`, forgetting the explicit legacy-event rejection would be silent data corruption rather than a type error; the fail-loud load test is therefore part of the proposal, not optional cleanup.
