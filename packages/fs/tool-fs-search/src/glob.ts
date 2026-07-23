/**
 * The model-facing `glob` tool: discover files whose paths match a glob
 * pattern, sorted by modification time. Execution goes through the bash seam
 * (`ctx.bash`) with a fixed `rg --files` command — this module owns the
 * model-facing schema, argument validation, shell-safe command construction,
 * result parsing, retention, and formatting; process concerns (defaulting,
 * scrubbing, kill, backend substitution) stay behind `ctx.bash`.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/glob
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { ItemRetainer } from '@deepseek-ai/dsh-retention'
import type { RetainedItems } from '@deepseek-ai/dsh-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-bash'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { singleQuote } from './shell-quote.ts'
import { acceptedSurfaceValue } from './surface.ts'

/**
 * Default cap on paths retained inline by one `glob` call (the `globMaxResults`
 * config), matching Claude Code's default `GlobTool` result limit.
 */
export const GLOB_MAX_RESULTS = 100

/**
 * Directory names ripgrep must never descend into for a discovery listing: VCS
 * metadata stores. `--no-ignore --hidden` would otherwise surface them in every
 * broad search. Each name is excluded with TWO negated `--glob`s (see
 * {@link buildGlobCommand}): an any-depth directory glob that matches — and
 * prunes — the directory during traversal, and a contents glob that still
 * excludes the internals when the search root itself is at or inside the
 * directory (an explicit `path` of `.git` or `sub/.git`), where the prune glob
 * alone never matches.
 */
export const GLOB_VCS_EXCLUDES: readonly string[] = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** Resolved glob-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GlobToolCaps {
  /** Max paths retained inline; later paths go to the formatted spill file. */
  maxResults: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `glob` arguments. */
export interface GlobInput {
  pattern: string
  path?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `pattern`, and a non-blank `path` when given. Throws a plain `Error` (an
 * ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `glob` arguments.
 * @returns the accepted input, unchanged.
 */
export function parseGlobArgs(args: { pattern: string; path?: string }): GlobInput {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  return { pattern: args.pattern, ...args.path !== undefined ? { path: args.path } : {} }
}

/**
 * Build the fixed `rg --files` command for one `glob` call. Every
 * model-controlled value ({@link GlobInput.pattern}, {@link GlobInput.path})
 * passes through {@link singleQuote}; the search root rides behind `--` so a
 * leading-dash path can never be parsed as a flag. `--sort=modified` orders by
 * modification time, `--no-ignore --hidden` searches ignored and hidden files,
 * and {@link GLOB_VCS_EXCLUDES} keeps VCS metadata out.
 *
 * @param input - the validated arguments.
 * @returns the complete, shell-safe command string.
 */
export function buildGlobCommand(input: GlobInput): string {
  const parts = [
    'rg --files',
    `--glob=${singleQuote(input.pattern)}`,
    '--sort=modified --no-ignore --hidden',
    // Two negated globs per VCS name: the bare form prunes the directory
    // during traversal; the /** form still excludes the contents when the
    // search root is AT or INSIDE the directory (where the bare form,
    // matched against root-prefixed paths, never fires).
    ...GLOB_VCS_EXCLUDES.flatMap(name => [
      `--glob=${singleQuote(`!**/${name}`)}`,
      `--glob=${singleQuote(`!**/${name}/**`)}`,
    ]),
  ]
  if (input.path !== undefined) parts.push('--', singleQuote(input.path))
  return parts.join(' ')
}

/**
 * Format the model-facing `glob` result: the retained paths, then — when the
 * result was capped — a footer carrying either the formatted-spill recovery
 * locator or the could-not-save explanation. The omitted count is a budget fact:
 * the search itself completed.
 *
 * @param retained - the retention outcome over every discovered path.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGlobOutput(retained: RetainedItems<string>, spillRef: SpillRef | undefined): string {
  const body = retained.items.join('\n')
  if (!retained.truncated) return body
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${body}\n\n(Showing ${retained.kept} of ${retained.seen} paths. ${recovery})`
}

/** Retain and format one canonical path list for the Native surface. */
function renderGlobPaths(paths: string[], maxResults: number, spillRef?: SpillRef): string {
  if (paths.length === 0) return 'No files found'
  const retainer = new ItemRetainer<string>({ kind: 'head', maxItems: maxResults })
  for (const path of paths) retainer.push(path)
  return formatGlobOutput(retainer.finish(), spillRef)
}

/**
 * Pending-call presentation: a search card titled by the pattern (and root).
 *
 * @param args - the raw tool arguments; `pattern` and `path` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGlobCall(args: { pattern: string; path?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  return { card: 'generic', title: `Glob ${args.pattern}${where}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Register the `glob` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `bash` service.
 * @param caps - the deployment's resolved glob caps (plugin config after defaulting).
 */
export function applyGlobTool(ctx: Context, caps: GlobToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: 103,
    text: 'Use the glob tool — not shell find or ls — to discover files by path pattern. Results are sorted by modification time and include hidden and ignored files.',
  })

  const tool = defineTool({
    name: 'glob',
    description: 'Find files whose paths match a glob pattern. Returns matching paths sorted by modification time, '
      + 'including hidden and ignored files (VCS metadata directories are excluded). '
      + `Returns the first ${caps.maxResults} paths inline; a capped result reports where the complete list was saved.`,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js").' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, caps.maxResults) }],
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const run = await runRipgrep(ctx, exec, 'glob', buildGlobCommand(input), caps.rawOutputMaxBytes)
      if (run.noMatches) return { paths: [] }

      const all: string[] = []
      for (const line of run.stdout.split('\n')) {
        if (line.length === 0) continue
        const displayPath = toWorkdirRelative(line, run.workdir)
        all.push(displayPath)
      }
      return { paths: all }
    },
    presentCall: presentGlobCall,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedSurfaceValue(ctx, tool, exec, result, decision) as { paths: string[] } | undefined
    if (value === undefined) return decision
    const paths = value.paths
    if (paths.length <= caps.maxResults) return decision
    const spillRef = await trySaveFormattedResult(ctx, exec, 'glob-results.txt', paths.join('\n'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGlobPaths(paths, caps.maxResults, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
