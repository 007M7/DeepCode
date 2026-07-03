/**
 * The model-facing filesystem tool suite (`read`, `write`, `edit`) over the
 * `ctx.fs` provider seam. This single plugin registers all three tools.
 *
 * ## The tool is the executor; policy is an event gate
 *
 * The tool reads/writes/edits through `ctx.fs` DIRECTLY and owns model-facing
 * concerns only — tool names, JSON schemas, argument validation, prompt
 * sections, read windowing, result formatting. It does NOT inject a policy
 * service. Instead, on each write/edit it dispatches a single-slot waterfall
 * (`fs/write-intent`/`fs/edit-intent`) to obtain the OPTIONAL version guard, and
 * after every read/write/edit it emits `fs/observed` with a plain (unguarded)
 * `ctx.emit`. A policy plugin (`@deepseek-ai/dsh-fs-policy`) occupies the
 * decision slot and listens for `fs/observed` to add observed-state +
 * read-before-edit + version-guarded write/edit; a deployment that loads these
 * tools is expected to also load it. With no policy plugin the waterfalls fall
 * through to their `undefined` default (the unconstrained bare provider) and
 * `fs/observed` is unheard — the tool still functions. This package never
 * imports `node:fs`, `node:path`, or an `@deepseek-ai/dsh-fs-local`
 * implementation.
 *
 * @module @deepseek-ai/dsh-tool-fs
 */

import type { Context } from 'cordis'
import { applyReadTool } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'

export { READ_LIMIT, STREAM_MIN_SIZE, applyReadTool, parseReadArgs } from './read.ts'
export { applyWriteTool, formatWriteOutput, parseWriteArgs } from './write.ts'
export { applyEditTool, formatEditOutput, parseEditArgs } from './edit.ts'
export { READ_MAX_BYTES, READ_MAX_LINE_LENGTH, buildWindow, formatReadOutput } from './read-render.ts'
export type { FileReadOutcome, FileTextLine, ReadWindow, WindowResult } from './read-render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Register the full `read`/`write`/`edit` filesystem tool suite. */
export function apply(ctx: Context): void {
  applyReadTool(ctx)
  applyWriteTool(ctx)
  applyEditTool(ctx)
}
