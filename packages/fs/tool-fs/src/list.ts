/**
 * Model-facing directory listing. It enumerates ONE directory level through the
 * provider seam's `listDir`, orders children so a capped view keeps the
 * navigable structure, and renders the entries with their type.
 *
 * This is the orientation tool: `glob` and `grep` answer "where is the thing I
 * can already name", while `list` answers "what is here at all". `rg --files`
 * never emits directories, so no pattern makes `glob` describe a directory's
 * shape — the gap this tool closes.
 * @module @deepseek-ai/dsh-tool-fs/list
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { countEntries, formatListOutput, orderEntries } from './list-render.ts'
import { sessionResolveOptions } from './session-cwd.ts'

/** Resolved list-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ListToolCaps {
  /** Maximum entries returned on one page; the footer still reports complete size and composition. */
  maxEntries: number
}

/** Validated `list` arguments after defaulting. */
export interface ListInput {
  /** Directory to list; `.` means the calling agent's session workspace. */
  path: string
  /** 1-based first entry to return from the directory-first ordering. */
  offset: number
}

/**
 * Validate value constraints the schema DSL can't express, and default an
 * omitted `path` to `.` — the session workspace, so "what is in this project"
 * needs no argument at all.
 *
 * @param args - the schema-validated `list` arguments.
 * @returns the accepted input with `path` and `offset` defaulted.
 */
export function parseListArgs(args: { path?: string; offset?: number }): ListInput {
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  const offset = args.offset ?? 1
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
  return { path: args.path ?? '.', offset }
}

/**
 * Pending-call presentation: a generic card titled by the directory, with a
 * follow-along location so a capable editor can reveal it.
 *
 * @param args - the raw tool arguments; `path` and `offset` feed the title.
 * @returns the generic card view shown while the call runs.
 */
export function presentListCall(args: { path?: string; offset?: number }): GenericCallView {
  const path = args.path ?? '.'
  const window = args.offset !== undefined ? ` (from entry ${args.offset})` : ''
  return { card: 'generic', title: `List ${path}${window}`, kind: 'read', locations: [{ path }] }
}

/**
 * Register the `list` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved list caps (plugin config after defaulting).
 */
export function applyListTool(ctx: Context, caps: ListToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:list',
    order: 99,
    text: 'Use the list tool — not shell ls — to see what a directory contains. It returns the direct children of one directory, files and subdirectories alike, '
      + 'and defaults to the session workspace, so it is the first step for orienting in an unfamiliar project. '
      + 'When a result is capped, continue with the offset named in its footer.',
  })

  ctx.tools.register(defineTool({
    name: 'list',
    description: 'List the direct children of one directory, with their type. '
      + `Entries are directories first, then files, each alphabetical; up to ${caps.maxEntries} are returned from the requested offset, and the footer gives the complete count plus a next offset when more remain. `
      + 'It includes subdirectories and is the tool for seeing one directory\'s contents.',
    parameters: {
      path: { type: 'string', description: 'Directory to list. Defaults to the session workspace; a relative path resolves against it.' },
      offset: { type: 'number', description: '1-based first entry to return. Defaults to 1; use the footer value to continue.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
              },
            },
          },
          totalEntries: { type: 'integer', required: true },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              directories: { type: 'integer', required: true },
              files: { type: 'integer', required: true },
              other: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatListOutput(value) }],
    },
    // Listing reads directory metadata only: no content, no version recorded,
    // nothing a concurrent call could observe out of order.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseListArgs(args)
      const target = await ctx.fs.resolve(input.path, sessionResolveOptions(exec, input.path))
      // No stat first: the seam already answers absence with FS_NOT_FOUND and a
      // non-directory target with FS_NOT_DIRECTORY, so a probe would only add a
      // round-trip and a second source of truth. (0 stat.)
      const entries = orderEntries(await ctx.fs.listDir(target, exec.signal))
      if (input.offset > entries.length && !(entries.length === 0 && input.offset === 1)) {
        throw new FsError(
          `offset ${input.offset} is out of range for "${target.displayPath}" (${entries.length} entries)`,
          'FS_NOT_FOUND',
        )
      }
      return {
        path: target.displayPath,
        offset: input.offset,
        entries: entries
          .slice(input.offset - 1, input.offset - 1 + caps.maxEntries)
          .map(({ name, type }) => ({ name, type })),
        totalEntries: entries.length,
        counts: countEntries(entries),
      }
    },
    presentCall: presentListCall,
  }))
}
