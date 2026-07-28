/**
 * The model-facing `glob` tool: discover files whose paths match a glob
 * pattern, sorted by modification time. Execution goes through the bash seam
 * (`ctx.bash`) with a fixed `rg --files` command — this module owns the
 * model-facing schema, argument validation, shell-safe command construction,
 * result parsing, inline sampling, and formatting; process concerns (defaulting,
 * scrubbing, kill, backend substitution) stay behind `ctx.bash`.
 *
 * A complete result keeps ripgrep's modification-time order. A result too large
 * to show inline does NOT: its inline page is sampled across the complete
 * result's top-level entries ({@link sampleAcrossTopLevel}), because the sorted
 * head of a broad match is routinely one subtree's worth of files and reads as
 * if the workspace held nothing else.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/glob
 */

import type { Context } from 'cordis'
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
  /** Paths to show inline: grouped by top-level entry, recency-ordered within each group. */
  items: string[]
  /** Distinct top-level entries the shown paths reach. */
  shown: number
  /** Distinct top-level entries across the complete result. */
  total: number
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
  const trimmed = path.replace(/^[\\/]+/, '')
  const cut = trimmed.search(/[\\/]/)
  return cut === -1 ? trimmed : trimmed.slice(0, cut)
}

/**
 * Choose the inline page of an over-cap result by round-robin across the
 * complete result's top-level entries, instead of taking its head.
 *
 * `--sort=modified` (oldest first) is the right order for a complete result and
 * the wrong basis for a sample of one: a broad pattern in a workspace holding one
 * unpacked archive — whose restored timestamps predate everything the user
 * wrote — gives a head that is entirely that subtree, and the model reads the
 * page as the workspace. Round-robin gives every top-level entry a slot before
 * any entry gets a second, so the page spans the tree; an entry that runs out of
 * paths drops out and its remaining slots go to the rest.
 *
 * Modification-time order survives where it still means something: groups are
 * visited in the order ripgrep first emits them, and each group's own paths keep
 * their relative order. With one path per group — a flat result — this
 * reproduces the sorted head exactly, so nothing changes for a result that has
 * no subtree to hide.
 *
 * @param paths - the complete result, in ripgrep's modification-time order.
 * @param maxItems - how many paths the page may hold; the caller has already established it is smaller than `paths`.
 * @returns the page grouped by top-level entry, with the shown/total top-level spread.
 */
export function sampleAcrossTopLevel(paths: readonly string[], maxItems: number): GlobSample {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const group = groups.get(topLevelSegment(path))
    if (group === undefined) groups.set(topLevelSegment(path), [path])
    else group.push(path)
  }
  // Bounding the rounds by the largest group makes termination structural: the
  // page can only fill or the groups run out, never spin on empty rounds.
  const rounds = Math.max(0, ...[...groups.values()].map(group => group.length))
  const taken = new Map<string, string[]>()
  let count = 0
  for (let round = 0; round < rounds && count < maxItems; round += 1) {
    for (const [key, group] of groups) {
      if (count >= maxItems) break
      const path = group[round]
      if (path === undefined) continue
      count += 1
      const bucket = taken.get(key)
      if (bucket === undefined) taken.set(key, [path])
      else bucket.push(path)
    }
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size }
}

/**
 * Format a CAPPED `glob` result: the inline page, then a footer stating that
 * the page is a cross-directory sample rather than the most recent paths, how
 * much of the top level it reaches, and either the formatted-spill recovery
 * locator or the could-not-save explanation. The omitted count is a budget
 * fact: the search itself completed. A result that fits inline never reaches
 * here — it is emitted verbatim, in ripgrep's order.
 *
 * A result whose every path is its own top-level entry keeps the plain footer:
 * the sample is the recency-ordered head, and naming a spread would only
 * restate the path counts already there.
 *
 * @param sample - the inline page and its top-level spread.
 * @param seen - how many paths the complete result holds; always more than the page.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGlobOutput(sample: GlobSample, seen: number, spillRef: SpillRef | undefined): string {
  const body = sample.items.join('\n')
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  const basis = sample.total === seen
    ? '.'
    : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.`
      + (sample.shown < sample.total ? ' Use the list tool to see what a directory contains.' : '')
  return `${body}\n\n(Showing ${sample.items.length} of ${seen} paths${basis} ${recovery})`
}

/** Bound and format one canonical path list for the Native surface. */
function renderGlobPaths(paths: string[], maxResults: number, spillRef?: SpillRef): string {
  if (paths.length === 0) return 'No files found'
  // A result that fits is shown whole, untouched: modification-time order is the
  // tool's contract, and over a complete result it is what answers age questions.
  if (paths.length <= maxResults) return paths.join('\n')
  return formatGlobOutput(sampleAcrossTopLevel(paths, maxResults), paths.length, spillRef)
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
    text: 'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. '
      + 'Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, while a larger one is sampled across top-level directories, '
      + 'so it spans the tree instead of one subtree. Use the list tool to see what a directory contains.',
  })

  const tool = defineTool({
    name: 'glob',
    description: 'Find files whose paths match a glob pattern. Returns matching file paths — never directories — '
      + 'including hidden and ignored files (VCS metadata directories are excluded). '
      + `Up to ${caps.maxResults} paths come back in modification-time order; a larger result instead returns ${caps.maxResults} paths sampled across top-level directories, `
      + 'says so, and reports where the complete sorted list was saved. To see what a directory contains, use the list tool instead.',
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
