/**
 * The model-facing `read` tool: inspect a UTF-8 text file and return
 * line-numbered content with pagination guidance. Execution goes through
 * `ctx.fs` — this module owns only the model-facing schema, argument
 * validation, and result formatting, never filesystem I/O.
 *
 * @module @deepseek-ai/dsh-tool-fs/read
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FsReadOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Default and maximum number of lines returned by one `read` call. */
export const READ_LIMIT = 2000

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

/** Format a read outcome as one OpenCode-style line-numbered text block body. */
export function formatReadOutput(displayPath: string, outcome: FsReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}

/** Register the `read` tool and its system-prompt guidance. */
export function apply(ctx: Context): void {
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
      const target = await ctx.fs.resolve(input.filePath)
      const outcome = await ctx.fs.read(target, { offset: input.offset, limit: input.limit }, exec, exec.signal)
      return [{ type: 'text', text: formatReadOutput(target.displayPath, outcome) }]
    },
  }))
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-read'

/** Services required by the `read` tool plugin. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Named helper for direct registration in the root plugin and tests. */
export const applyReadTool = apply
