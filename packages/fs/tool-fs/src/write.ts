/**
 * The model-facing `write` tool: create or fully replace a UTF-8 text file. The
 * tool is the executor: it dispatches the `fs/write-intent` waterfall to
 * obtain the optional version guard, calls `ctx.fs.writeText` directly, and
 * emits `fs/observed`. The default thunk returns `undefined` (unconditional
 * create-or-overwrite — the bare provider); a policy plugin
 * (`@deepseek-ai/dsh-fs-policy`) occupies the single decision slot and
 * returns `createIfAbsent`/`replaceIfVersion` instead. The tool stats ZERO
 * times either way.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/write
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionCwd } from './session-cwd.ts'

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
export function applyWriteTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-policy requires it) and prefer edit for targeted changes.',
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
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, cwd !== undefined ? { cwd } : undefined)
      // Single-slot decision: the policy plugin produces createIfAbsent/
      // replaceIfVersion; the bare default is undefined (unconditional). No stat.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal)
      // Record the observed version (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, outcome.version, exec)
      return [{ type: 'text', text: formatWriteOutput(target.displayPath, outcome) }]
    },
    // Pure display: a diff card (an editor renders write as a new-file / full-
    // replace diff). `oldText: null` — a call-time presenter has no access to the
    // file's prior content, so even an overwrite renders new-file style, matching
    // claude-agent-acp. A follow-along location points at the written file.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Write ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
