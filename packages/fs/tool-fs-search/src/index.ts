/**
 * The model-facing filesystem discovery tool suite (`glob`, `grep`) over the
 * bash executor seam (`ctx.bash`). This single plugin registers both tools
 * only when the mounted bash executor can find `rg` on its `PATH`.
 *
 * ## Bash-backed, not a `ctx.fs` provider method
 *
 * Local workspace discovery is a process-backed `rg` workflow, so these tools
 * execute through `ctx.bash.resolve(request)` → `ctx.bash.run(spec)` with fixed
 * ripgrep command templates — never `ctx.bash.start()`, never a model-visible
 * background task. The tool layer owns schemas, argument validation, shell
 * quoting ({@link module:@deepseek-ai/dsh-tool-fs-search/shell-quote}), result
 * parsing, retention, formatted-result spill, and timeout declaration; the
 * bash executor owns request defaulting/capping, subprocess execution,
 * process-group termination, environment scrubbing, raw output capture, and
 * backend substitution. At load, the package probes `command -v rg` through the
 * same bash seam; if ripgrep is absent, `glob` / `grep` and their prompt
 * sections are not registered. The package injects `tools`, `systemPrompt`,
 * and `bash` — deliberately NOT `fs`, and `ctx.spillStore` is read
 * opportunistically with `ctx.get()` because formatted-result spill is optional.
 *
 * Returned paths are displayed relative to the resolved bash workdir and are
 * follow-up-readable only in co-located deployments where the bash workdir and
 * the filesystem `read` root are the same workspace — a documented v1
 * deployment requirement, not runtime-validated.
 *
 * @module @deepseek-ai/dsh-tool-fs-search
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { GLOB_MAX_RESULTS, applyGlobTool } from './glob.ts'
import { GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, applyGrepTool } from './grep.ts'
import { RAW_OUTPUT_MAX_BYTES, SEARCH_TIMEOUT_MS } from './search-core.ts'

export { GLOB_MAX_RESULTS, GLOB_VCS_EXCLUDES, applyGlobTool, buildGlobCommand, formatGlobOutput, parseGlobArgs, presentGlobCall } from './glob.ts'
export type { GlobInput, GlobToolCaps } from './glob.ts'
export {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  applyGrepTool,
  buildGrepCommand,
  formatGrepMatches,
  formatGrepOutput,
  parseGrepArgs,
  parseGrepMatches,
  presentGrepCall,
  previewLine,
} from './grep.ts'
export type { GrepInput, GrepMatch, GrepToolCaps } from './grep.ts'
export { RAW_OUTPUT_MAX_BYTES, SEARCH_TIMEOUT_MS, SearchError, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
export type { RipgrepRun, SearchErrorCode } from './search-core.ts'
export { singleQuote } from './shell-quote.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs-search'

/** Services required by the search tool suite (`spillStore` is optional, read via `ctx.get()`). */
export const inject = ['tools', 'systemPrompt', 'bash']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Max paths one `glob` call retains inline; later paths go to the formatted spill file. */
  globMaxResults?: number
  /** Max flat matches one `grep` call retains inline; later matches go to the formatted spill file. */
  grepMaxMatches?: number
  /** Max bytes retained for one matched-line preview (the cut preserves UTF-8 boundaries). */
  grepMaxLineBytes?: number
  /** Max complete raw `rg` stdout bytes a search will parse; larger raw output fails with `SEARCH_RAW_OUTPUT_OVERFLOW`. */
  rawOutputMaxBytes?: number
  /** Cooperative tool-call timeout budget (ms) on both tools, enforced by `@deepseek-ai/dsh-timeout-policy` through `exec.signal`. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  rawOutputMaxBytes: z.number().default(RAW_OUTPUT_MAX_BYTES),
  timeoutMs: z.number().default(SEARCH_TIMEOUT_MS),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** POSIX-shell builtin probe for the ripgrep binary in the bash executor environment. */
const RG_PROBE_COMMAND = 'command -v rg >/dev/null 2>&1'

/** Every search cap counts items/bytes/milliseconds — a positive integer, or retention and timeout arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs-search: ${name} must be a positive integer`)
  }
}

/**
 * Check whether the mounted bash executor can find `rg`.
 *
 * Nonzero exit means "not available" and disables this optional tool suite.
 * Infrastructure failures stay loud: a deployment with a broken bash executor
 * should not silently lose tools in a way that looks like a deliberate skip.
 *
 * @param ctx - plugin context whose `bash` service is the executor the tools will use.
 * @returns true when `command -v rg` exits 0, false when it exits nonzero.
 */
async function ripgrepAvailable(ctx: Context): Promise<boolean> {
  const spec = ctx.bash.resolve({ command: RG_PROBE_COMMAND })
  let result
  try {
    result = await ctx.bash.run(spec)
  } catch (error: unknown) {
    throw new Error(`tool-fs-search: ripgrep availability probe could not start: ${String(error)}`, { cause: error })
  }
  if (result.aborted || result.timedOut || result.signal !== null || result.exitCode === null) {
    throw new Error('tool-fs-search: ripgrep availability probe did not complete')
  }
  return result.exitCode === 0
}

/**
 * Register the `glob`/`grep` filesystem discovery tool suite when `rg` exists.
 *
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 * @returns when ripgrep is unavailable, resolves without registering any tools.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('globMaxResults', resolved.globMaxResults)
  assertPositiveInteger('grepMaxMatches', resolved.grepMaxMatches)
  assertPositiveInteger('grepMaxLineBytes', resolved.grepMaxLineBytes)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  if (!await ripgrepAvailable(ctx)) {
    ctx.logger.warn('tool-fs-search: ripgrep (rg) not found on the bash executor PATH; glob/grep tools not registered')
    return
  }
  applyGlobTool(ctx, {
    maxResults: resolved.globMaxResults,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
  applyGrepTool(ctx, {
    maxMatches: resolved.grepMaxMatches,
    maxLineBytes: resolved.grepMaxLineBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
}
