/**
 * The filesystem provider seam (`ctx.fs`): an abstract service defining the
 * text-storage primitives a backend provides — resolve a path into a stable
 * target, stat its metadata, read/stream its text, write it atomically with an
 * explicit intent, and apply a guarded literal edit — without saying HOW.
 * Implementations subclass {@link FileSystem} and register themselves as the
 * `fs` service; `@deepseek-ai/dsh-fs-local` (the host filesystem) is the first.
 * Future implementations swap in sandboxed, remote, virtual, or project-scoped
 * backends without touching the model-facing tool schemas
 * (`@deepseek-ai/dsh-tool-fs`).
 *
 * The split mirrors the bash seam (`BashExecutor`/`LocalBashExecutor`). See the
 * capability-seam RFC for why a swappable capability is three (here four)
 * packages.
 *
 * ## This is a provider seam, not the policy layer
 *
 * `ctx.fs` is deliberately close to fsspec-style storage primitives. It owns
 * UTF-8 decoding, binary/NUL rejection, atomic full-file writes, and the
 * literal-edit critical section — but NOT line windows, numbered lines,
 * rendered footers, or observed-state. Read windowing lives in the model-facing
 * tool (`@deepseek-ai/dsh-tool-fs`); observed-state and read-before-write/edit
 * are policy a plugin (`@deepseek-ai/dsh-fs-policy`) adds through the `fs/*`
 * event gate. So a sandboxed/remote backend inherits no model-facing observation
 * policy it has no business carrying.
 *
 * `editText` stays on this seam (not composed in the policy layer from a read
 * plus a write) because version guard + literal match + atomic rewrite must
 * stay inside one mutation critical section for correct error attribution and
 * one-wins/one-stale concurrency, and a remote backend may implement it as a
 * native compare-and-edit.
 *
 * ## The version guard is OPTIONAL — additive policy, not subtractive
 *
 * `ctx.fs` on its own is a complete, unconstrained text-storage seam: `read`
 * reads, `write` unconditionally creates-or-overwrites, `edit` unconditionally
 * replaces literal text in the current content. Both mutations take their
 * version guard as an OPTIONAL argument — omit it for the unconstrained
 * bare-provider behavior, supply it to guard against a concurrent change. The
 * mutation runs inside the backend's per-target lock either way, so an
 * unconditional write/edit is still atomic; "unconditional" drops the *version*
 * precondition, not the atomicity. Observed-state, read-before-edit, and
 * version-guarded write/edit are NOT provider behavior — they are policy a
 * plugin (`@deepseek-ai/dsh-fs-policy`) adds on top by supplying the guard.
 *
 * ## The fs policy events live here, not in the policy plugin
 *
 * This package owns the `fs/write-intent`, `fs/edit-intent`, and
 * `fs/observed` event vocabulary (see {@link Events}). The emitter is
 * `@deepseek-ai/dsh-tool-fs` and the default listener is
 * `@deepseek-ai/dsh-fs-policy`; the events live in the one package both
 * already depend on, so the emitter shares a vocabulary with the policy listener
 * without depending on the policy plugin. The events carry only `dsh-fs`
 * vocabulary plus an opaque `object` actor — no model-facing concepts (line
 * windows, numbered lines) and no agent/session owner structure leak down.
 *
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from 'cordis'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

export {
  FsError,
  FsTargetKey,
  FsVersion,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsDirEntry,
  FsErrorCode,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    /**
     * Single-slot decision: produce the write intent for the next
     * {@link FileSystem.writeText}. The tool dispatches this as an unbound
     * waterfall (no `this`) and supplies a default thunk returning `undefined`
     * (unconditional create-or-overwrite — the bare provider). The
     * `@deepseek-ai/dsh-fs-policy` policy listener returns `createIfAbsent`
     * (unobserved actor) or `{ kind: 'replaceIfVersion', version: vObserved }`
     * (observed) and does NOT call `next()` — one decision, not a composable
     * chain. The slot is first-wins: the first non-`next()` decider (registration
     * order, or `prepend`) occupies it; a second decider is a misconfiguration,
     * not layering. `actor` is the opaque tool-execution context, never read here.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision: produce the optional version guard for the next
     * {@link FileSystem.editText}. The tool dispatches this as an unbound
     * waterfall and supplies a default thunk returning `undefined` (unconditional
     * edit of the current content — the bare provider; no `stat`). The
     * `@deepseek-ai/dsh-fs-policy` policy listener returns
     * `{ version: vObserved }`, or throws `FS_NOT_OBSERVED` if the actor is unset
     * or has not observed the target. Does NOT call `next()`: one decision,
     * first-wins (see {@link Events.'fs/write-intent'}).
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record that an actor observed a target at a version, after a successful
     * read/write/edit. Fire-and-forget (plain `emit`). A listener MUST be a
     * synchronous, side-effect-only recorder (`@deepseek-ai/dsh-fs-policy`'s
     * is a `WeakMap.set`): the tool does not guard the emit, so a listener that
     * throws surfaces as the tool's `isError` result, and cordis `emit` does not
     * await listener promises — async or fallible audit/telemetry does not
     * belong here. No listener ⇒ nothing recorded. `actor` is the opaque
     * tool-execution context.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, version: FsVersion, actor: object | undefined): void
  }
}

/**
 * Abstract filesystem provider service. Subclass, implement the seven storage
 * primitives, and load the subclass as a plugin — it registers as `ctx.fs` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every backend must honor:
 * - {@link resolve} returns a stable {@link FsTarget}; the same underlying file
 *   reached by different input paths must yield the same `targetKey` so stale
 *   guards and target lookup agree across paths (e.g. through symlinks).
 * - {@link stat} returns {@link FsInfo} metadata (never content) or `undefined`
 *   when the target is absent.
 * - {@link readText}/{@link streamText} read the whole regular text file (the
 *   stream for large files); both own regular-file checks, UTF-8 decoding,
 *   binary/NUL rejection, and `FS_NOT_TEXT`.
 * - {@link listDir} returns direct children of a directory in stable name order
 *   with resolved child targets and cheap metadata only. It never reads file
 *   contents. Missing targets throw `FS_NOT_FOUND`, non-directories throw
 *   `FS_NOT_DIRECTORY`, permission failures throw `FS_PERMISSION_DENIED`, and
 *   other backend I/O failures throw `FS_IO_ERROR`.
 * - {@link writeText} is atomic temp-file + rename. `expected` is OPTIONAL:
 *   omit it for an unconditional create-or-overwrite (the bare-provider default),
 *   or supply a {@link FsWriteIntent} to guard the write.
 * - {@link editText} verifies `expected.version` BEFORE literal matching (so a
 *   stale edit reports `FS_STALE_VERSION`, not `FS_EDIT_NOT_FOUND`/
 *   `FS_AMBIGUOUS_EDIT` against newer content), then applies literal replacement
 *   and writes atomically — all inside one mutation critical section. `expected`
 *   is OPTIONAL: omit it for an unconditional edit of the current content (a
 *   missing target still reports `FS_STALE_VERSION`).
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May
   * perform I/O (a remote/sandboxed backend may need a round-trip to map a path
   * to a stable identity), hence async even though the local backend only
   * normalizes + realpaths.
   *
   * `opts.cwd` is the base directory a RELATIVE `path` resolves against; an
   * absolute `path` ignores it. Omitted ⇒ the backend's own default base (the
   * local backend uses its configured `cwd`). The CALLER supplies this — the
   * seam does not read a session or agent — so a tool can resolve against the
   * caller's per-session workspace (`exec.agent.session.header.cwd`) without the
   * provider depending on `dsh-agent`/`dsh-session`. Mirrors how `dsh-tool-bash`
   * defaults a bash `workdir` to the session cwd.
   */
  abstract resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>

  /** Return target metadata, or `undefined` when the target does not exist. */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /** Read the whole regular text file as a single decoded string. */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * Stream the whole regular text file as decoded text chunks (same text
   * semantics as {@link readText}, for large files). The backend owns
   * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
   * touches raw bytes.
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * List direct children of a directory in stable name order. Returns resolved
   * child targets plus cheap metadata only; never reads file contents.
   */
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  /**
   * Create or fully replace a UTF-8 text file atomically. `expected` is the
   * create-vs-replace decision and stale guard when supplied; OMITTING it is an
   * unconditional create-or-overwrite (the bare provider — no version guard, no
   * read-first requirement). Atomic either way.
   */
  abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>

  /**
   * Apply a literal edit to an existing UTF-8 text file. When `expected` is
   * supplied, verifies `expected.version` as the stale guard BEFORE literal
   * matching; OMITTING it edits the current content unconditionally (no version
   * guard). Either way applies the replacement and writes atomically — one
   * mutation critical section — and a missing target reports `FS_STALE_VERSION`.
   */
  abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
}

export default FileSystem
