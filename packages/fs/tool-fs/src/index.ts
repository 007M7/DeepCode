/**
 * The model-facing filesystem tool suite (`read`, `write`, `edit`) over the
 * `ctx.fileContext` policy layer. This root plugin registers all three tools by
 * composing the per-tool registration helpers; each tool is also exposed as a
 * subpath plugin (`@deepseek-ai/dsh-tool-fs/read`, `/write`, `/edit`) for focused
 * deployments.
 *
 * The package owns model-facing concerns only — tool names, JSON schemas,
 * argument validation, prompt sections, result formatting. All filesystem
 * execution goes through `ctx.fileContext` (never directly around it to
 * `ctx.fs`), so every model read records observed-state before rendering; this
 * package never imports `node:fs`, `node:path`, or an
 * `@deepseek-ai/dsh-fs-local` implementation.
 *
 * @module @deepseek-ai/dsh-tool-fs
 */

import type { Context } from 'cordis'
import { applyReadTool } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'

export { READ_LIMIT, applyReadTool, formatReadOutput, parseReadArgs } from './read.ts'
export { applyWriteTool, formatWriteOutput, parseWriteArgs } from './write.ts'
export { applyEditTool, formatEditOutput, parseEditArgs } from './edit.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fileContext', 'systemPrompt']

/** Register the full `read`/`write`/`edit` filesystem tool suite. */
export function apply(ctx: Context): void {
  applyReadTool(ctx)
  applyWriteTool(ctx)
  applyEditTool(ctx)
}
