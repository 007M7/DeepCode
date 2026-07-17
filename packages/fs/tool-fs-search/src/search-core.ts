/**
 * Shared execution plumbing for the `glob` / `grep` search tools: the
 * package-owned `SEARCH_*` error vocabulary, one bash-seam run helper that
 * turns a fixed `rg` command into complete raw stdout, the best-effort
 * formatted-result spill handoff, and workdir-relative path display.
 *
 * Both tools execute through `ctx.bash.resolve(request)` → `ctx.bash.run(spec)`
 * as ordinary foreground tool calls — never `ctx.bash.start()`, never a
 * model-visible background task. Raw `rg` stdout is an internal transport
 * detail: the tools request a per-run stdout capture budget from the bash seam,
 * parse only complete in-memory stdout within `rawOutputMaxBytes`, and never
 * read executor spill files. The model-facing recovery artifact is the
 * formatted result saved through `ctx.spillStore.saveText()`
 * ({@link trySaveFormattedResult}).
 *
 * @module @deepseek-ai/dsh-tool-fs-search/search-core
 */

import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from 'cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BashRunResult, CollectedOutput } from '@deepseek-ai/dsh-bash'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Default cap on the complete raw `rg` stdout the tools will parse (the
 * `rawOutputMaxBytes` config), matching Claude Code's ripgrep raw buffer.
 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000

/**
 * Default cooperative tool-call timeout budget in milliseconds (the `timeoutMs`
 * config), attached to both tool definitions for
 * `@deepseek-ai/dsh-timeout-policy` to enforce through `exec.signal`.
 */
export const SEARCH_TIMEOUT_MS = 30_000

/**
 * Stable, machine-routable codes for search failures. Package-owned (not
 * `FsErrorCode`) because these tools are bash-backed discovery, not `ctx.fs`
 * provider operations: `SEARCH_INVALID_PATTERN` — ripgrep rejected the regex or
 * glob; `SEARCH_FAILED` — the search could not run or its output could not be
 * parsed (missing `rg`, inaccessible target, signal kill, malformed `--json`);
 * `SEARCH_RAW_OUTPUT_OVERFLOW` — raw `rg` output exceeded `rawOutputMaxBytes`
 * or stayed truncated after that requested stdout budget; `SEARCH_ABORTED` — the tool
 * timeout, caller cancellation, or the bash executor's own timeout cut the
 * search short.
 */
export type SearchErrorCode =
  | 'SEARCH_INVALID_PATTERN'
  | 'SEARCH_FAILED'
  | 'SEARCH_RAW_OUTPUT_OVERFLOW'
  | 'SEARCH_ABORTED'

/**
 * Typed search failure. Extends {@link HarnessError} so it carries a stable
 * {@link SearchErrorCode} and chains `cause`; the tool registry surfaces
 * `{ name, code }` on `isError` results so retry/permission/UI layers can
 * branch without parsing messages.
 */
export class SearchError extends HarnessError {
  override readonly code: SearchErrorCode

  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** The completed acquisition of one `rg` run: complete stdout plus the resolved workdir. */
export interface RipgrepRun {
  /** Complete raw stdout retained by the bash executor within the requested cap. */
  stdout: string
  /** True when ripgrep exited 1: a successful search with zero results. */
  noMatches: boolean
  /** The resolved working directory the command ran in (the display-relativization base). */
  workdir: string
}

/**
 * The retained stderr tail as a diagnostic excerpt, with a truncation note when
 * the executor dropped bytes (the tool never reads `stderr.spillPath`).
 */
function stderrExcerpt(stderr: CollectedOutput): string {
  const text = stderr.text.trim()
  if (text.length === 0) return ''
  return stderr.truncated ? `${text} [stderr truncated]` : text
}

/** Classify a nonzero-exit `rg` run into the search error vocabulary (invalid pattern vs missing `rg` vs everything else). */
function classifyRunFailure(toolName: string, result: BashRunResult): SearchError {
  const stderr = stderrExcerpt(result.stderr)
  if (/regex parse error|error parsing glob/i.test(stderr)) {
    return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, 'SEARCH_INVALID_PATTERN')
  }
  if (result.exitCode === 127 || /command not found/i.test(stderr)) {
    return new SearchError(`${toolName} requires ripgrep (rg) on the bash executor's PATH${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')
  }
  return new SearchError(`${toolName} search failed (exit ${result.exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')
}

/**
 * Acquire the COMPLETE raw stdout of a finished run, enforcing
 * `rawOutputMaxBytes` on the in-memory transport. A truncated result means the
 * bash backend could not retain complete stdout within the requested budget, so
 * the tool fails clearly instead of parsing a silently-partial stream.
 */
function completeStdout(toolName: string, result: BashRunResult, rawOutputMaxBytes: number): string {
  const narrow = 'narrow pattern, path, or include and retry'
  if (!result.stdout.truncated) {
    const inlineBytes = Buffer.byteLength(result.stdout.text, 'utf8')
    if (inlineBytes > rawOutputMaxBytes) {
      throw new SearchError(
        `${toolName} produced ${inlineBytes} bytes of raw output, over the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
        'SEARCH_RAW_OUTPUT_OVERFLOW',
      )
    }
    return result.stdout.text
  }
  throw new SearchError(
    `${toolName} produced more raw output than the bash executor retained within the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
    'SEARCH_RAW_OUTPUT_OVERFLOW',
  )
}

/**
 * Run one fixed `rg` command through the bash seam and return its complete raw
 * stdout. The bash request workdir is the calling agent's session cwd
 * (`exec.agent.session.header.cwd`) when available — mirroring `dsh-tool-bash` /
 * `dsh-tool-fs` — else omitted so the implementation's `resolve()` applies its
 * configured default. `exec.signal` is forwarded so the cooperative tool
 * timeout (`@deepseek-ai/dsh-timeout-policy`) and caller cancellation kill the
 * command; the bash backend's own timeout stays a second safety cap.
 *
 * Exit semantics are tool-owned: exit 0 is success with results, exit 1 is
 * success with zero results (`noMatches`), anything else throws a
 * {@link SearchError} (abort/timeout → `SEARCH_ABORTED`, invalid pattern →
 * `SEARCH_INVALID_PATTERN`, the rest → `SEARCH_FAILED` /
 * `SEARCH_RAW_OUTPUT_OVERFLOW`). A `run()` REJECTION — the seam's
 * infrastructure failures (pre-aborted signal, unusable workdir, missing
 * shell) — is translated into the same taxonomy: a pre-aborted signal becomes
 * `SEARCH_ABORTED`, everything else `SEARCH_FAILED`, with the original as
 * `cause`.
 *
 * @param ctx - the plugin context; execution uses its `bash` service.
 * @param exec - the tool-execution context; supplies the session cwd and the abort signal.
 * @param toolName - `glob` or `grep`, used in error messages.
 * @param command - the fully-quoted `rg` command string (every model value already through `singleQuote`).
 * @param rawOutputMaxBytes - cap on the complete raw stdout the tool will parse.
 * @returns the complete stdout, the zero-result flag, and the resolved workdir.
 */
export async function runRipgrep(
  ctx: Context,
  exec: ToolExecution,
  toolName: string,
  command: string,
  rawOutputMaxBytes: number,
): Promise<RipgrepRun> {
  const cwd = exec.agent?.session.header.cwd
  const spec = ctx.bash.resolve({
    command,
    stdoutMaxBytes: rawOutputMaxBytes,
    ...cwd !== undefined ? { workdir: cwd } : {},
    ...exec.signal ? { signal: exec.signal } : {},
  })
  let result: BashRunResult
  try {
    result = await ctx.bash.run(spec)
  } catch (error: unknown) {
    // The seam contract: run() REJECTS only for infrastructure failures — a
    // pre-aborted signal, an unusable workdir, a missing shell. Translate them
    // so these failures stay machine-routable under the SEARCH_* taxonomy.
    if (spec.signal?.aborted === true) {
      throw new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED', { cause: error })
    }
    throw new SearchError(`${toolName} could not start its search command (unusable working directory or missing shell)`, 'SEARCH_FAILED', { cause: error })
  }
  if (result.aborted) {
    throw new SearchError(`${toolName} was aborted before completion (tool timeout or caller cancellation)`, 'SEARCH_ABORTED')
  }
  if (result.timedOut) {
    throw new SearchError(`${toolName} timed out after ${result.timeoutMs}ms in the bash executor; narrow pattern, path, or include and retry`, 'SEARCH_ABORTED')
  }
  if (result.signal !== null || result.exitCode === null) {
    throw new SearchError(`${toolName} search command was killed by signal ${result.signal ?? '(unknown)'}`, 'SEARCH_FAILED')
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw classifyRunFailure(toolName, result)
  }
  const stdout = completeStdout(toolName, result, rawOutputMaxBytes)
  return { stdout, noMatches: result.exitCode === 1, workdir: spec.workdir }
}

/**
 * Map an `rg` output path to its display form: absolute paths inside the
 * resolved bash workdir become workdir-relative; everything else (relative
 * output, paths outside the workdir) passes through unchanged. Display-only —
 * returned paths are follow-up-readable in co-located bash/filesystem
 * deployments where both resolve the same workspace (the documented v1
 * deployment requirement).
 *
 * @param path - one path as ripgrep printed it.
 * @param workdir - the resolved bash workdir the command ran in.
 * @returns the workdir-relative display path when possible, else `path` unchanged.
 */
export function toWorkdirRelative(path: string, workdir: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(workdir, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel
}

/**
 * Best-effort save of one COMPLETE formatted search result through
 * `ctx.spillStore.saveText()` — the model-facing recovery path for a capped
 * result. `spillStore` is read with `ctx.get()` (not static inject) because
 * formatted-result spill is optional; the spill owner is the calling agent's
 * session header id and the source is the tool execution identity. A missing
 * backend, a call with no session owner, or a `saveText()` rejection logs a
 * warning and returns `undefined` — the caller keeps the inline result and
 * reports that the complete result could not be saved; search success never
 * turns into `isError` because spill storage is unavailable.
 *
 * @param ctx - the plugin context; `spillStore` is looked up opportunistically.
 * @param exec - the tool-execution context; supplies the owning session, tool name, and call id.
 * @param suggestedName - the backend-sanitized filename hint (e.g. `grep-results.txt`).
 * @param content - the complete formatted result to persist.
 * @returns the saved spill reference, or `undefined` when the result could not be saved.
 */
export async function trySaveFormattedResult(
  ctx: Context,
  exec: ToolExecution,
  suggestedName: string,
  content: string,
): Promise<SpillRef | undefined> {
  const sessionId = exec.agent?.session.header.id
  if (sessionId === undefined) {
    ctx.logger.warn(`tool-fs-search: no session owner for ${exec.name} result; complete result not saved`)
    return undefined
  }
  const spillStore = ctx.get('spillStore')
  if (!spillStore) {
    ctx.logger.warn(`tool-fs-search: no ctx.spillStore backend loaded; complete ${exec.name} result not saved`)
    return undefined
  }
  const save: SaveTextSpill = {
    owner: { sessionId },
    source: { toolName: exec.name, callId: exec.callId, label: 'result' },
    suggestedName,
    content,
  }
  try {
    return await spillStore.saveText(save)
  } catch (error: unknown) {
    // Best-effort: a storage failure must never fail the search or hide the
    // inline result — the footer reports the unsaved remainder instead.
    ctx.logger.warn(`tool-fs-search: saveText failed for ${exec.name}: ${String(error)}; complete result not saved`)
    return undefined
  }
}
