/**
 * Vocabulary for the file-context policy layer (`ctx.fileContext`): the
 * minimal execution-context shape used to derive an observed-state owner, the
 * resolved read window, and the structured read outcome the model-facing `read`
 * tool renders.
 *
 * The provider vocabulary (`FsTarget`, `FsVersion`, write/edit shapes) is
 * re-used from `@deepseek-ai/dsh-fs` — this package owns only the model-facing
 * read-windowing and observation policy on top of it.
 *
 * @module @deepseek-ai/dsh-file-context/types
 */

import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileTextLine } from './window.ts'

/**
 * Minimal structural view of a tool execution the policy layer needs to derive
 * an observed-state owner. `@deepseek-ai/dsh-tools`' `ToolExecution` satisfies
 * this shape, so the consumer passes its `exec` straight through without
 * `dsh-file-context` importing `dsh-tools`, `dsh-agent`, or `dsh-session`.
 *
 * The owner is `agent.session` when present. It is treated as an opaque object
 * identity (a `WeakMap` key); this package never reads any of its fields.
 */
export interface FileContextExec {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}

/** Resolved read window. The consumer applies its defaults/caps before calling. */
export interface FileReadRequest {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
}

/** Outcome of a bounded text read — what the model-facing `read` tool renders. */
export interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Maximum number of lines requested. */
  limit: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Total line count in the file, unless `truncatedByBytes` stopped scanning early. */
  totalLines: number
  /** Whether selected output hit the byte cap before EOF or the requested limit. */
  truncatedByBytes?: true
  /** Opaque version of the file at read time. */
  version: FsVersion
}
