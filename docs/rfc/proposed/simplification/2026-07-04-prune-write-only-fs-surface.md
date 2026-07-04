# RFC: Prune write-only fields and a dead routing knob from the fs seam

Status: proposed

## Problem

The [fs seam split](../../implemented/simplification/2026-06-26-fsspec-style-fs-seam.md) moved read routing and policy out of the backend into `dsh-tool-fs` and `dsh-fs-policy`. Four pieces of surface kept the pre-split shape — populated on every call, read by nobody:

1. **`STREAM_MIN_SIZE` + `FsIoInternals.streamMinSize` in `dsh-fs-local`** — *already removed by the no-hardcoded-tunables audit (the routing bound became `dsh-tool-fs`'s `readStreamMinSize` config); listed here for the record of the full prune, no work remains.* Originally (`packages/fs/fs-local/src/fsio.ts`, re-exported from `packages/fs/fs-local/src/index.ts`): zero readers anywhere, including fs-local's own source and tests. The backend has no read routing — `readWholeText`/`streamWholeText` are separate primitives the caller chooses between — and the real routing constant lives in the consumer (`packages/fs/tool-fs/src/read.ts`, compared against `info.size`). Two mirrors of the 10 MiB fact; the backend's is dead, and the knob's JSDoc claims a "read routing" override that does not exist.
2. **`FsTarget.inputPath`** (`packages/fs/fs/src/types.ts`): every backend and every test fake must fabricate a "diagnostics only" value with zero production readers — the policy plugin and every error message use `targetKey`/`displayPath`. The `listDir` producer exposes the semantic wobble: directory children get the bare entry name, which was nobody's "input".
3. **`FsEditOutcome.replacements` + `.replaceAll`** (`packages/fs/fs/src/types.ts`): `replacements` has zero production readers (the single-match policy itself stays — it is enforced by the `FS_AMBIGUOUS_EDIT`/`FS_EDIT_NOT_FOUND` throws inside the backend, whose error message keeps the internal count); `replaceAll` is read only by `formatEditOutput` in `packages/fs/tool-fs/src/edit.ts` — as an echo of the `replace_all` argument the tool already holds. Shrunk, `FsEditOutcome` becomes `{ version, before, after }`, parallel to `FsWriteOutcome`'s genuinely backend-discovered fields.
4. **`FileReadOutcome.limit` + `.version`** (`packages/fs/tool-fs/src/read-render.ts`): populated by the read tool, but `formatReadOutput` renders `offset`/`lines`/`totalLines`/`truncatedByBytes` only, and the `fs/observed` emit uses `info.version` directly rather than the outcome copy.

## Proposal

Delete the fs-local constant, its re-export, and the `streamMinSize` knob (the remaining `FsIoInternals` knobs are genuinely used by the atomic-write tests); drop `inputPath` from `FsTarget`; shrink `FsEditOutcome` to `{ version, before, after }` and pass `replaceAll` to `formatEditOutput` from the parsed args; drop `limit`/`version` from `FileReadOutcome`. Update the [filesystem.md](../../../core-data-structures/filesystem.md) pastes, the type-equiv manifest, `packages/fs/fs/README.md`, and the test fakes that currently must fabricate the removed fields.

## Why not keep them?

A future permission/containment layer might want the pre-resolution path for error text — but it would want the *request*, which every call site still holds. "N occurrences replaced" might become model-facing text — a behavior change to design when wanted, and the backend-internal count survives for its error message. A read footer might display `limit` — everything the footer shows already derives from `lines`/`totalLines`. Meanwhile every current and future backend (remote, native) must fabricate wire fields nobody consumes, and every test fake must satisfy them.

## Acceptance criteria

- The removed surfaces are gone — `STREAM_MIN_SIZE`/`streamMinSize` in `dsh-fs-local`, `FsTarget.inputPath`, `FsEditOutcome.replacements`/`.replaceAll`, and `FileReadOutcome.limit`/`.version` — while the request-side `replaceAll` (`FsEditSpec`) and the version fields on the other outcome types are untouched; doc pastes and the manifest in sync; the suite is green with the shrunk fakes.
- `formatEditOutput`'s emitted text is unchanged for both `replace_all` branches, so no snapshot golden churns.

## Risks

The in-flight fs discovery work (glob/grep tools) touches the same `dsh-fs` type files — a textual, not design, conflict; land in either order and reconcile mechanically. Backends gain no new obligations; they shed four.
