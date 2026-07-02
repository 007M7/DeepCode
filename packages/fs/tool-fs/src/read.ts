/**
 * The model-facing `read` tool: inspect a UTF-8 text file and return
 * line-numbered content with pagination guidance. The tool is the executor — it
 * stats and reads through `ctx.fs` directly, builds the line window
 * ({@link module:@deepseek-ai/dsh-tool-fs/read-render}), and emits `fs/observed`
 * so a policy plugin (`@deepseek-ai/dsh-fs-policy`) can record the read. With
 * no policy plugin the emit is simply unheard. This module owns the
 * model-facing schema, argument validation, and the read I/O; the rendering
 * (windowing + formatting) lives in `read-render.ts` and the
 * freshness/observation policy is not its concern.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildWindow, formatReadOutput } from './read-render.ts'
import type { FileReadOutcome } from './read-render.ts'
import { sessionCwd } from './session-cwd.ts'

/** Default and maximum number of lines returned by one `read` call. */
export const READ_LIMIT = 2000

/** Files at or above this size stream; smaller files read whole into memory. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/** Validate value constraints the schema DSL can't express. */
export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, 'limit')
  if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)
  return { filePath: args.file_path, offset, limit }
}

/** Register the `read` tool and its system-prompt guidance. */
export function applyReadTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
    },
    async execute(args, exec): Promise<ContentBlock[]> {
      const input = parseReadArgs(args)
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, cwd !== undefined ? { cwd } : undefined)

      // One stat: type check + size routing + the version recorded as observed.
      // A writer racing between this stat and the read can at worst make a LATER
      // guarded edit spuriously FS_STALE_VERSION (fail-closed: re-read; editText
      // re-checks the version in its lock).
      const info = await ctx.fs.stat(target, exec.signal)
      if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')

      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file.
      const chunks = info.size === undefined || info.size >= STREAM_MIN_SIZE
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      const window = await buildWindow(chunks, { offset: input.offset, limit: input.limit }, target.displayPath)

      const outcome: FileReadOutcome = {
        offset: input.offset,
        limit: input.limit,
        lines: window.lines,
        totalLines: window.totalLines,
        version: info.version,
        ...window.truncatedByBytes ? { truncatedByBytes: true } : {},
      }
      // Record the observed version (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, info.version, exec)
      return [{ type: 'text', text: formatReadOutput(target.displayPath, outcome) }]
    },
    // Pure display: a UI card titled by the file, `read` kind (icon), and a
    // location so an editor can follow along to the file (and the read's offset
    // line). `rawInput` surfaces offset/limit when the model narrowed the read.
    presentCall(args) {
      const detail = [
        ...args.offset !== undefined ? [`offset ${args.offset}`] : [],
        ...args.limit !== undefined ? [`limit ${args.limit}`] : [],
      ].join(', ')
      return {
        title: `Read ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path, ...args.offset !== undefined ? { line: args.offset } : {} }],
        ...detail.length > 0 ? { rawInput: detail } : {},
      }
    },
  }))
}
