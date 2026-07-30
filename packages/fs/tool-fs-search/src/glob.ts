/**
 * The model-facing `glob` tool: discover files whose paths match a glob
 * pattern, sorted by modification time. Execution goes through the bash seam
 * (`ctx.bash`) with a fixed `rg --files` command — this module owns the
 * model-facing schema, argument validation, shell-safe command construction,
 * result parsing, inline sampling, and formatting; process concerns (defaulting,
 * scrubbing, kill, backend substitution) stay behind `ctx.bash`.
 * @module @deepseek-ai/dsh-tool-fs-search/glob
 */

import type { Context } from 'cordis'
import { sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
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
  /** Whether over-cap pages are sampled across top-level entries instead of taking the modification-time head. */
  sampleOverCapGlobResults: boolean
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
 * The inline page of a capped `glob` result, plus how much of the complete
 * result's top level it reaches.
 */
export interface GlobSample {
  /** Paths to show inline: grouped by top-level entry, modification-time ordered within each group. */
  items: string[]
  /** Distinct top-level entries the shown paths reach. */
  shown: number
  /** Distinct top-level entries across the complete result. */
  total: number
}

/** Remove the displayed search-root prefix before choosing a top-level group. */
function relativeToSearchRoot(path: string, root: string): string {
  if (root === '.') return path.startsWith(`.${sep}`) ? path.slice(2) : path
  let rootEnd = root.length
  while (rootEnd > 0 && root[rootEnd - 1] === sep) rootEnd -= 1
  const trimmedRoot = root.slice(0, rootEnd)
  if (trimmedRoot.length === 0) return stripLeadingSeparators(path)
  if (path === trimmedRoot) return ''
  if (path.startsWith(`${trimmedRoot}${sep}`)) {
    return path.slice(trimmedRoot.length + 1)
  }
  return path
}

/** Strip only separators recognized by the execution platform. */
function stripLeadingSeparators(path: string): string {
  let start = 0
  while (path[start] === sep) start += 1
  return path.slice(start)
}

/**
 * The leading path segment of one display path — the top-level entry, relative
 * to the search root, that the path sits under. A path with no separator is its
 * own top-level entry. Leading separators are stripped first so an absolute path
 * (one outside the workdir, which {@link toWorkdirRelative} leaves untouched)
 * groups by its first real name instead of collapsing every such path into one
 * empty group.
 */
function topLevelSegment(path: string): string {
  const trimmed = stripLeadingSeparators(path)
  const cut = trimmed.indexOf(sep)
  return cut === -1 ? trimmed : trimmed.slice(0, cut)
}

/**
 * Choose the inline page of an over-cap result by round-robin across the
 * complete result's top-level entries, instead of taking its head.
 *
 * Every top-level entry receives a slot before any receives a second; exhausted
 * groups drop out. Group order and order within each group follow `paths`, so a
 * flat result reproduces the modification-time head.
 *
 * @param paths - the complete result, in ripgrep's modification-time order.
 * @param maxItems - how many paths the page may hold; the caller has already established it is smaller than `paths`.
 * @param root - the search root in the same display-path space as `paths`.
 * @returns the page grouped by top-level entry, with the shown/total top-level spread.
 */
export function sampleAcrossTopLevel(paths: readonly string[], maxItems: number, root = '.'): GlobSample {
  type ActiveGroup = { key: string; items: string[]; index: number; current: string }
  const groups = new Map<string, string[]>()
  let active: ActiveGroup[] = []
  for (const path of paths) {
    const key = topLevelSegment(relativeToSearchRoot(path, root))
    const group = groups.get(key)
    if (group === undefined) {
      const items = [path]
      groups.set(key, items)
      active.push({ key, items, index: 0, current: path })
    } else {
      group.push(path)
    }
  }
  const taken = new Map<string, string[]>()
  let count = 0
  while (active.length > 0 && count < maxItems) {
    const nextActive: ActiveGroup[] = []
    for (const { key, items, index, current } of active) {
      if (count >= maxItems) break
      count += 1
      const bucket = taken.get(key)
      if (bucket === undefined) taken.set(key, [current])
      else bucket.push(current)
      const nextIndex = index + 1
      const nextPath = items[nextIndex]
      if (nextPath !== undefined) nextActive.push({ key, items, index: nextIndex, current: nextPath })
    }
    active = nextActive
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size }
}

/**
 * Format a capped sampled page and its complete-result recovery path. A flat
 * result keeps the plain footer because its sample is the modification-time head.
 *
 * @param sample - the inline page and its top-level spread.
 * @param seen - how many paths the complete result holds; always more than the page.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGlobOutput(sample: GlobSample, seen: number, spillRef: SpillRef | undefined): string {
  const basis = sample.total === seen
    ? '.'
    : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.`
      + (sample.shown < sample.total ? ' Narrow path to inspect a specific subtree.' : '')
  return formatGlobPage(sample.items, seen, spillRef, basis)
}

/** Format one bounded page and the recovery path for its complete sorted result. */
function formatGlobPage(items: readonly string[], seen: number, spillRef: SpillRef | undefined, basis: string): string {
  const body = items.join('\n')
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${body}\n\n(Showing ${items.length} of ${seen} paths${basis} ${recovery})`
}

/** Bound and format one canonical path list for the Native surface relative to its search root. */
function renderGlobPaths(paths: string[], caps: GlobToolCaps, root: string, spillRef?: SpillRef): string {
  if (paths.length === 0) return 'No files found'
  // A result that fits is shown whole, untouched: modification-time order is the
  // tool's contract, and over a complete result it is what answers age questions.
  if (paths.length <= caps.maxResults) return paths.join('\n')
  if (!caps.sampleOverCapGlobResults) {
    return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef, '.')
  }
  return formatGlobOutput(sampleAcrossTopLevel(paths, caps.maxResults, root), paths.length, spillRef)
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
  const overCapGuidance = caps.sampleOverCapGlobResults
    ? 'while a larger one is sampled across top-level entries, so it spans the tree instead of one subtree.'
    : 'while a larger one keeps the modification-time-ordered head.'
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: 103,
    text: 'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. '
      + `Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, ${overCapGuidance}`,
  })

  const overCapDescription = caps.sampleOverCapGlobResults
    ? `a larger result instead returns ${caps.maxResults} paths sampled across top-level entries`
    : `a larger result returns the first ${caps.maxResults} paths in modification-time order`
  const tool = defineTool({
    name: 'glob',
    description: 'Find files whose paths match a glob pattern. Returns matching file paths — never directories — '
      + 'including hidden and ignored files (VCS metadata directories are excluded). '
      + `Up to ${caps.maxResults} paths come back in modification-time order; ${overCapDescription}, `
      + 'says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). '
          + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
      },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, caps, value.root) }],
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const run = await runRipgrep(ctx, exec, 'glob', buildGlobCommand(input), caps.rawOutputMaxBytes)
      const root = input.path === undefined ? '.' : toWorkdirRelative(input.path, run.workdir)
      if (run.noMatches) return { root, paths: [] }

      const all: string[] = []
      for (const line of run.stdout.split('\n')) {
        if (line.length === 0) continue
        const displayPath = toWorkdirRelative(line, run.workdir)
        all.push(displayPath)
      }
      return { root, paths: all }
    },
    presentCall: presentGlobCall,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedSurfaceValue(ctx, tool, exec, result, decision) as { root: string; paths: string[] } | undefined
    if (value === undefined) return decision
    const paths = value.paths
    if (paths.length <= caps.maxResults) return decision
    const spillRef = await trySaveFormattedResult(ctx, exec, 'glob-results.txt', paths.join('\n'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGlobPaths(paths, caps, value.root, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
