/**
 * Vocabulary for the filesystem provider seam (`ctx.fs`): the opaque
 * target/version identities, the metadata `stat` returns, the write-intent
 * and outcome shapes, the literal-edit request/outcome, and the typed error
 * taxonomy.
 *
 * These types are shared by every backend (`@deepseek-ai/dsh-fs-local` and
 * future sandboxed/remote backends) and by the policy layer
 * (`@deepseek-ai/dsh-fs-policy`). They are deliberately a *text-storage*
 * vocabulary half a level above byte-level fsspec: `readText`/`streamText` hand
 * back decoded text, never raw bytes. Host-path assumptions stay out — `targetKey`
 * and `version` are opaque branded tokens, and `displayPath` is the only field a
 * consumer may show.
 *
 * Model-facing concepts (line windows, numbered lines, observed-state) do NOT
 * live here; they belong to the consumer tool and the policy plugin
 * (`@deepseek-ai/dsh-tool-fs` / `@deepseek-ai/dsh-fs-policy`).
 *
 * @module @deepseek-ai/dsh-fs/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
export type FsTargetKey = Branded<'FsTargetKey'>

/** Brand a string as an {@link FsTargetKey}. */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from mtime+size; a remote backend might use a
 * revision id. The policy layer records it for stale checks; consumers may
 * display related metadata but MUST NOT interpret this token.
 */
export type FsVersion = Branded<'FsVersion'>

/** Brand a string as an {@link FsVersion}. */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}

/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
export interface FsTarget {
  /** The original model/plugin-supplied path, for diagnostics only. */
  inputPath: string
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}

/**
 * Metadata about a target — what {@link FileSystem.stat} returns. Lets the
 * policy layer reject directories/special files before reading and choose
 * `readText` vs `streamText` from `size` without probing by failure. `version`
 * is the freshness token. `undefined` from `stat` means the target is absent.
 */
export interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/**
 * The explicit intent of a guarded {@link FileSystem.writeText} call.
 * `createIfAbsent` creates a missing target and rejects an existing one with
 * `FS_NOT_OBSERVED` (the path the policy plugin uses when the owner has no prior
 * read). `replaceIfVersion` replaces only when the target exists at the observed
 * version; a missing target or a version mismatch throws `FS_STALE_VERSION`.
 *
 * `writeText` takes this OPTIONALLY: omitting `expected` is the third,
 * unconstrained state — an unconditional create-or-overwrite (the bare
 * provider). The union itself carries only the two GUARDED intents; "no guard"
 * is expressed by omission, so the write and edit mutations share one symmetric
 * shape (`expected?`: omit = unconditional, present = guarded).
 */
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

/** Outcome of a full-file write. */
export interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
  /**
   * The file's content BEFORE the write, or `null` when the file did not exist
   * (a create) or was undiffable (binary/non-UTF-8). LF-normalized storage text
   * (the diff basis), never a diff — a consumer computes the result-time
   * contextual diff from `before`/`after` when `before` is present, else falls
   * back to a whole-file diff.
   */
  before: string | null
  /** The file's content AFTER the write, LF-normalized to share `before`'s diff basis. */
  after: string
}

/** A literal-replacement edit request. */
export interface FsEditRequest {
  /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
  oldString: string
  /** Literal replacement text. An empty string deletes the matched text. */
  newString: string
  /** Replace every match instead of requiring exactly one. */
  replaceAll: boolean
}

/** Outcome of a literal edit. */
export interface FsEditOutcome {
  /** Number of literal replacements applied. */
  replacements: number
  /** Whether every match was replaced. */
  replaceAll: boolean
  /** Opaque version of the file after the edit. */
  version: FsVersion
  /**
   * The file's content BEFORE the edit. Raw storage text (LF-normalized by the
   * backend), never a diff — a consumer computes the result-time contextual diff
   * (the applied hunk with context) from `before`/`after`.
   */
  before: string
  /** The file's content AFTER the edit. */
  after: string
}

/**
 * Stable, machine-routable codes for filesystem failures. Carried on
 * {@link FsError}; the tool registry surfaces `{ name, code }` on `isError`
 * results so retry/permission/UI layers can branch without parsing messages.
 */
export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

/**
 * Typed filesystem error. Extends {@link HarnessError} so it carries a stable
 * {@link FsErrorCode} and chains `cause`. `dsh-fs` owns this vocabulary so
 * backends and the policy layer raise the same codes instead of each inventing
 * message strings.
 */
export class FsError extends HarnessError {
  override readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
