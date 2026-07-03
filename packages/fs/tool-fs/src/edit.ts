/**
 * The model-facing `edit` tool: update an existing UTF-8 text file by replacing
 * literal text, requiring a unique match by default. The tool is the executor:
 * it dispatches the `fs/edit-intent` waterfall to obtain the optional
 * version guard, calls `ctx.fs.editText` directly, and emits `fs/observed`. The
 * default thunk returns `undefined` (unconditional edit of the current content
 * — the bare provider); a policy plugin (`@deepseek-ai/dsh-fs-policy`)
 * occupies the single decision slot, returning `{ version: vObserved }` or
 * throwing `FS_NOT_OBSERVED` for an unread file. The tool stats ZERO times
 * either way; a missing target is reported by the provider as `FS_STALE_VERSION`.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FsEditOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { computeHunkDiffs, diffsFromMeta, type FsDiffMeta } from './diff.ts'
import { sessionCwd } from './session-cwd.ts'

/** Validated `edit` arguments after defaulting. */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/** Validate value constraints the schema DSL can't express. */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/** Format an edit outcome as a Claude-style model-facing success message. */
export function formatEditOutput(displayPath: string, outcome: FsEditOutcome): string {
  return outcome.replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/** Register the `edit` tool and its system-prompt guidance. */
export function applyEditTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    async execute(args, exec): Promise<{ content: ContentBlock[]; meta?: FsDiffMeta }> {
      const input = parseEditArgs(args)
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, cwd !== undefined ? { cwd } : undefined)
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis.
      const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.editText(
        target,
        { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
        intent,
        exec.signal,
      )
      // Record the observed version (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, outcome.version, exec)
      // The result-time applied-hunk diff (before→after with context lines). An
      // edit always changes content (parseEditArgs requires old_string to differ
      // and editText matches at least once), so there is always at least one hunk.
      // The bridge renders these as an inline diff that supersedes the call-time
      // snippet; the display path is the model-facing `file_path` (the bridge
      // relativizes it).
      const diffs = computeHunkDiffs(input.filePath, outcome.before, outcome.after)
      return {
        content: [{ type: 'text', text: formatEditOutput(target.displayPath, outcome) }],
        meta: { diffs },
      }
    },
    // Pure display: a diff card of the literal replacement (old_string →
    // new_string), derived from the call args. `oldText: old_string || null`
    // matches claude-agent-acp's Edit arm; new_string is a required arg here, so
    // it maps straight to newText. A follow-along location points at the file.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    // Result-time display: the applied contextual-diff hunks carried on `meta`.
    // On success with diffs, a `diff` result card supersedes the call-time
    // snippet; on error (nothing applied) or malformed meta, fall through to the
    // generic "updated successfully" rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
