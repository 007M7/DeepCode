/**
 * Vocabulary for the filesystem capability seam (`ctx.fs`): the request/outcome
 * shapes backends produce and consumers format, the opaque target/version
 * identities, the per-owner file-state record, and the typed error taxonomy.
 *
 * These types are shared by every backend (`@deepseek-ai/dsh-fs-local` and
 * future sandboxed/remote backends) and by the model-facing consumer
 * (`@deepseek-ai/dsh-tool-fs`). They deliberately avoid host-path assumptions:
 * `targetKey` and `version` are opaque tokens, and `displayPath` is the only
 * field a consumer may show.
 *
 * @module @deepseek-ai/dsh-fs/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Minimal structural view of a tool execution the filesystem seam needs to
 * derive a file-state owner. `@deepseek-ai/dsh-tools`' `ToolExecution`
 * satisfies this shape, so the consumer passes its `exec` straight through
 * without `dsh-fs` importing `dsh-tools`, `dsh-agent`, or `dsh-session`.
 *
 * The owner is `agent.session` when present. It is treated as an opaque object
 * identity (a `WeakMap` key); `dsh-fs` never reads any of its fields.
 */
export interface FsExecContext {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}

/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
export interface FsTarget {
  /** The original model/plugin-supplied path, for diagnostics only. */
  inputPath: string
  /**
   * Opaque key for stale guards and file-state lookup. The local backend uses
   * a realpath-like string; a remote backend might use a workspace URI or file
   * id. Consumers MUST NOT parse it or assume it is a local absolute path.
   */
  targetKey: string
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}

/**
 * Opaque file-version token. The local backend derives it from mtime+size; a
 * remote backend might use a revision id. `ctx.fs` records it for stale checks;
 * consumers may display related metadata but MUST NOT interpret this token.
 */
export type FsVersion = string

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface FsReadRequest {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
}

/** One line returned from a text file. */
export interface FsTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}

/** Whether a recorded/returned view covers the whole file or only part of it. */
export type FsView = 'full' | 'partial'

/** Outcome of a bounded text read. */
export interface FsReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Maximum number of lines requested. */
  limit: number
  /** Returned lines, already numbered. */
  lines: FsTextLine[]
  /** Total line count in the file, unless `truncatedByBytes` stopped scanning early. */
  totalLines: number
  /** Whether selected output hit the byte cap before EOF or the requested limit. */
  truncatedByBytes?: true
  /** Opaque version of the file at read time. */
  version: FsVersion
  /**
   * Whether this read saw the whole file (`full`) or only part of it
   * (`partial`). Only a `full` view authorizes a later write/edit.
   */
  view: FsView
}

/**
 * The read-before-write decision the base service hands to a backend for a
 * full-file write. `observed` means the owner has a `full` view recorded at
 * `version` (the backend rejects if the file has since changed); `partial`
 * means the owner saw only a non-editable view of that target; `unobserved`
 * means there is no prior view (the backend may create iff the target is
 * absent, else rejects as not observed).
 */
export type FsExpectation =
  | { kind: 'observed'; version: FsVersion }
  | { kind: 'partial'; version: FsVersion }
  | { kind: 'unobserved' }

/** Outcome of a full-file write. */
export interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
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
}

/** Source that last touched a recorded {@link FileState}. */
export type FsStateSource = 'read' | 'write' | 'edit'

/**
 * What an owner has observed about one target. Keyed (inside the service) first
 * by the owner object, then by {@link FsTarget.targetKey}. Only a `full` view
 * authorizes write/edit.
 */
export interface FileState {
  /** Backend target identity this state describes. */
  targetKey: string
  /** Display path captured when the state was recorded. */
  displayPath: string
  /** Opaque version the owner last saw. */
  version: FsVersion
  /** Whether the owner saw the whole file or only part of it. */
  view: FsView
  /** Wall-clock time the state was last updated (ms since epoch). */
  updatedAt: number
  /** Operation that produced this state. */
  source: FsStateSource
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
  | 'FS_PARTIAL_OBSERVATION'
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
