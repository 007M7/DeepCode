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
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { computeHunkDiffs, diffsFromMeta, type FsDiffMeta } from './diff.ts'
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
    async execute(args, exec): Promise<{ content: ContentBlock[]; meta?: FsDiffMeta }> {
      const input = parseWriteArgs(args)
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, cwd !== undefined ? { cwd } : undefined)
      // Single-slot decision: the policy plugin produces createIfAbsent/
      // replaceIfVersion; the bare default is undefined (unconditional). No stat.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal)
      // Record the observed version (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, outcome.version, exec)
      // Attach a contextual hunk as `meta` ONLY for an overwrite (a before-version
      // exists). A create has no "before" — `outcome.before` is null — so it
      // carries no `meta`; `presentResult` then renders a whole-file diff from the
      // args, so the completed card is still a diff (never the result text).
      const diffs = outcome.before !== null ? computeHunkDiffs(input.filePath, outcome.before, outcome.after) : []
      return {
        content: [{ type: 'text', text: formatWriteOutput(target.displayPath, outcome) }],
        ...diffs.length > 0 ? { meta: { diffs } } : {},
      }
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
    // Result-time display: a `diff` card so the completed `tool_call_update`
    // re-installs the diff rather than the model-facing result text (an ACP
    // `tool_call_update.content` REPLACES the call's content, so a text result
    // would clobber the pending diff card). An OVERWRITE uses the applied
    // contextual hunks on `meta`; a CREATE has no `meta` (no prior content), so
    // its whole-file new-file diff is derived from `args.content` (replay-safe,
    // matching the call-time card). An error falls through to generic rendering
    // so its message shows.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
        ?? [{ path: args.file_path, oldText: null, newText: args.content }]
      return { card: 'diff', title: `Write ${args.file_path}`, diffs }
    },
  }))
}
