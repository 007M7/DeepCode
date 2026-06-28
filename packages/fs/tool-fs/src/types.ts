/**
 * Vocabulary for the model-facing filesystem tools (`@deepseek-ai/dsh-tool-fs`):
 * the structured read outcome the `read` tool renders. The read window
 * (`offset`/`limit`) and per-line shape live in
 * {@link module:@deepseek-ai/dsh-tool-fs/window}; this file owns the assembled
 * outcome the tool formats.
 *
 * The provider vocabulary (`FsTarget`, `FsVersion`, write/edit shapes) is
 * re-used from `@deepseek-ai/dsh-fs` — this package owns only the model-facing
 * read-rendering shape on top of it.
 *
 * @module @deepseek-ai/dsh-tool-fs/types
 */

import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileTextLine } from './window.ts'

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
