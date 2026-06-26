/**
 * The model-facing `write` tool: create or fully replace a UTF-8 text file.
 * Execution goes through `ctx.fileContext`, which enforces the freshness policy
 * (creating a new file needs no prior read; replacing an existing file requires
 * a prior read in the same execution context at the unchanged version).
 *
 * @module @deepseek-ai/dsh-tool-fs/write
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Validate value constraints the schema DSL can't express. */
export function parseWriteArgs(args: { file_path: string; content: string }): { filePath: string; content: string } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  return { filePath: args.file_path, content: args.content }
}

/** Format a write outcome as one model-facing text block body. */
export function formatWriteOutput(displayPath: string, outcome: FsWriteOutcome): string {
  const verb = outcome.operation === 'create' ? 'Created' : 'Updated'
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${verb} file
</content>`
}

/** Register the `write` tool and its system-prompt guidance. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the backend requires it) and prefer edit for targeted changes.',
  })

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    },
    async execute(args, exec): Promise<ContentBlock[]> {
      const input = parseWriteArgs(args)
      const target = await ctx.fileContext.resolve(input.filePath)
      const outcome = await ctx.fileContext.write(target, input.content, exec, exec.signal)
      return [{ type: 'text', text: formatWriteOutput(target.displayPath, outcome) }]
    },
  }))
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-write'

/** Services required by the `write` tool plugin. */
export const inject = ['tools', 'fileContext', 'systemPrompt']

/** Named helper for direct registration in the root plugin and tests. */
export const applyWriteTool = apply
