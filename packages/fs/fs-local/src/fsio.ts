/**
 * Cordis-free local-filesystem I/O for `@deepseek-ai/dsh-fs-local`. Kept
 * separate from the service class (mirroring `dsh-bash-local`'s `run.ts`) so
 * the raw read/write/edit mechanics can be unit-tested without a Context.
 *
 * The reader uses two code paths so a single huge line can never balloon
 * memory: a **fast path** (`readFile` + in-memory split) for files under
 * {@link FAST_PATH_MAX_SIZE}, and a **streaming path** (manual newline scan
 * with a capped line buffer) for larger files. Both reject NUL-byte binary
 * samples and keep only the requested page in memory.
 *
 * Writes are atomic: content goes to a temp file opened exclusively (`wx`,
 * `0o600`, so a pre-existing path can never be clobbered and write-in-progress
 * bytes stay owner-only) inside a randomly-named private staging directory
 * (`0o700`) next to the target, then `rename`d over the target. Edits are
 * read-modify-write over the same atomic primitive.
 *
 * @module @deepseek-ai/dsh-fs-local/fsio
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsReadRequest, FsTextLine, FsView } from '@deepseek-ai/dsh-fs'

/** Default and maximum number of lines returned by one read. */
export const READ_LIMIT = 2000

/** Maximum characters returned for a single line. */
export const READ_MAX_LINE_LENGTH = 2000

/** Maximum bytes returned for selected file lines. */
export const READ_MAX_BYTES = 50 * 1024

/** Files smaller than this use the in-memory fast path; larger files stream. */
export const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024

const READ_MAX_BYTES_LABEL = `${READ_MAX_BYTES / 1024} KB`
const READ_MAX_LINE_SUFFIX = `... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
const BINARY_SAMPLE_BYTES = 8192
const NUL_CHAR = String.fromCharCode(0)
const LINE_BUFFER_CAP = READ_MAX_LINE_LENGTH + 1

/**
 * Test seam: lets specs force the streaming path (via a small
 * `fastPathMaxSize`) and pin the temp-file name (to prove exclusive-open
 * behavior) without a 10 MB fixture or a name race.
 */
export interface FsIoInternals {
  /** Override {@link FAST_PATH_MAX_SIZE} for routing. */
  fastPathMaxSize?: number
  /** Override the generated private staging-dir name (relative to the target dir). */
  tempDirName?: (writePath: string) => string
  /** Override the generated temp-file name (relative to the private staging dir). */
  tempName?: (writePath: string) => string
  /** Test hook after the temp file is written/synced but before final chmod+rename. */
  inspectTemp?: (paths: { stagingDir: string; tempPath: string }) => void | Promise<void>
}

/** A resolved local path: the absolute path shown to callers and its realpath identity. */
export interface LocalTarget {
  /** Absolute path (symlinks not resolved) — used for display. */
  displayPath: string
  /** Realpath identity — used as the stable target key and the I/O path. */
  targetKey: string
}

/** Result of probing a path: null when it does not exist. */
export interface PathInfo {
  version: string
  mode: number
  isFile: boolean
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/* v8 ignore start -- composes secondary cleanup-failure messages, which require a filesystem/kernel fault after the primary failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* v8 ignore stop */

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/** Opaque version token from a stat: mtime (ns precision) + size. */
function versionOf(info: Stats): string {
  return `${info.mtimeMs}:${info.size}`
}

/**
 * Resolve a path to its absolute display path and realpath identity. Relative
 * paths are based on `cwd`. The `targetKey` realpaths the parent directory and
 * re-appends the basename, so a not-yet-created file gets the same stable key
 * it will have after creation (the directory exists even when the file does
 * not). Two input paths reaching the same file via symlinks share one key.
 * Falls back to the absolute path when even the parent cannot be resolved.
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    // Prefer the file's own realpath (resolves a symlinked file to its target).
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error: unknown) {
    /* v8 ignore next -- non-ENOENT realpath failure needs a permission/IO fault; ENOENT falls through to parent-dir resolution. */
    if (!isENOENT(error)) throw error
  }
  try {
    // File absent: realpath the parent dir + basename so creates get a stable key.
    return { displayPath, targetKey: join(await realpath(dirname(displayPath)), basename(displayPath)) }
  } catch (error: unknown) {
    /* v8 ignore next -- parent-dir realpath failing needs the dir itself to be missing/unreadable; fall back to the absolute path. */
    if (!isENOENT(error)) throw error
    return { displayPath, targetKey: displayPath }
  }
}

/** Probe a path for its version, mode, and regular-file status. Null if absent. */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  try {
    const info = await stat(absolutePath)
    return { version: versionOf(info), mode: info.mode & 0o777, isFile: info.isFile() }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; surface it. */
    if (!isENOENT(error)) throw error
    return null
  }
}

// --- Reading ---

interface PageAccumulator {
  lines: FsTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
  done: boolean
}

function newAccumulator(): PageAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false, done: false }
}

function truncateReadLine(line: string): string {
  return line.length > READ_MAX_LINE_LENGTH
    ? `${line.substring(0, READ_MAX_LINE_LENGTH)}${READ_MAX_LINE_SUFFIX}`
    : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: PageAccumulator, rawLine: string, request: FsReadRequest): void {
  acc.totalLines += 1
  if (acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateReadLine(rawLine)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > READ_MAX_BYTES) {
    acc.truncatedByBytes = true
    acc.done = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** The outcome shape `readTextPage` returns (minus the offset/limit echo, which the caller adds). */
export interface ReadPageResult {
  lines: FsTextLine[]
  totalLines: number
  truncatedByBytes: boolean
  view: FsView
  version: string
}

function buildResult(acc: PageAccumulator, request: FsReadRequest, version: string, displayPath: string): ReadPageResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  const endLine = acc.lines.at(-1)?.number ?? Math.max(0, request.offset - 1)
  const view: FsView = request.offset === 1 && !acc.truncatedByBytes && endLine >= acc.totalLines ? 'full' : 'partial'
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes, view, version }
}

/**
 * Read a bounded UTF-8 text-file page. Rejects non-regular files and NUL-byte
 * binary samples; dispatches to the fast or streaming path by file size.
 */
export async function readTextPage(
  target: LocalTarget,
  request: FsReadRequest,
  signal?: AbortSignal,
  internals: FsIoInternals = {},
): Promise<ReadPageResult> {
  throwIfAborted(signal, 'read')
  const absolutePath = target.targetKey
  let info: Stats
  try {
    info = await stat(absolutePath)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; only the not-found path is reachable in tests. */
    if (!isENOENT(error)) throw error
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')

  const version = versionOf(info)
  const fastPathMax = internals.fastPathMaxSize ?? FAST_PATH_MAX_SIZE
  return info.size < fastPathMax
    ? readTextPageFast(target, request, version, signal)
    : readTextPageStreaming(target, request, version, signal)
}

async function readTextPageFast(
  target: LocalTarget,
  request: FsReadRequest,
  version: string,
  signal?: AbortSignal,
): Promise<ReadPageResult> {
  const raw = await readFile(target.targetKey, signal ? { signal } : {})
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  }

  const text = raw.toString('utf8')
  const acc = newAccumulator()
  let startPos = 0
  let newlinePos: number
  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    consumeLine(acc, stripCarriageReturn(text.slice(startPos, newlinePos)), request)
    if (acc.done) break
    startPos = newlinePos + 1
  }
  if (!acc.done && startPos < text.length) {
    consumeLine(acc, stripCarriageReturn(text.slice(startPos)), request)
  }
  return buildResult(acc, request, version, target.displayPath)
}

async function readTextPageStreaming(
  target: LocalTarget,
  request: FsReadRequest,
  version: string,
  signal?: AbortSignal,
): Promise<ReadPageResult> {
  const stream = createReadStream(target.targetKey, { encoding: 'utf8', ...signal ? { signal } : {} })
  const acc = newAccumulator()
  let lineBuffer = ''
  let firstChunk = true

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= LINE_BUFFER_CAP) return
    lineBuffer += segment
    if (lineBuffer.length > LINE_BUFFER_CAP) lineBuffer = lineBuffer.slice(0, LINE_BUFFER_CAP)
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      if (firstChunk) {
        firstChunk = false
        if (chunk.slice(0, BINARY_SAMPLE_BYTES).includes(NUL_CHAR)) {
          throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
        }
      }
      let startPos = 0
      let newlinePos: number
      while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
        appendToLineBuffer(chunk.slice(startPos, newlinePos))
        flushLine()
        startPos = newlinePos + 1
        if (acc.done) return buildResult(acc, request, version, target.displayPath)
      }
      appendToLineBuffer(chunk.slice(startPos))
    }
  } catch (error: unknown) {
    /* v8 ignore next 4 -- mid-stream errors need an abort/IO fault racing the loop; pre-abort is caught by throwIfAborted. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }

  if (lineBuffer.length > 0) flushLine()
  return buildResult(acc, request, version, target.displayPath)
}

/** Format the line-numbered body + pagination footer for a read page. */
export function formatReadBody(result: ReadPageResult, offset: number): string {
  const endLine = result.lines.at(-1)?.number ?? Math.max(0, offset - 1)
  let footer: string
  if (result.truncatedByBytes) {
    footer = `(Output capped at ${READ_MAX_BYTES_LABEL}. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < result.totalLines) {
    footer = `(Showing lines ${offset}-${endLine} of ${result.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${result.totalLines} lines)`
  }
  return result.lines.length > 0
    ? `${result.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
}

// --- Writing ---

async function removeStagingDirOrThrow(stagingDir: string, originalError: unknown): Promise<never> {
  try {
    await rm(stagingDir, { recursive: true, force: true })
  } catch (cleanupError: unknown) {
    /* v8 ignore next 1 -- cleanup failure here needs a second filesystem fault after the primary write failure. */
    throw new FsError(`write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`, 'FS_NOT_FOUND', { cause: originalError })
  }
  throw originalError
}

/**
 * Atomically write `content` to `absolutePath`: create parent dirs, write to a
 * randomly-named temp file opened exclusively (`wx`, `0o600`) inside a private
 * (`0o700`) staging directory, fsync, optionally chmod to the final mode while
 * still private, then rename over the target. `mode` (when given) preserves an
 * existing file's permissions across the replace.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  internals: FsIoInternals = {},
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = internals.tempDirName?.(absolutePath) ?? `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempName = internals.tempName?.(absolutePath) ?? `${basename(absolutePath)}.tmp`
  const tempPath = join(stagingDir, tempName)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
    await handle.sync()
    await internals.inspectTemp?.({ stagingDir, tempPath })
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    await rename(tempPath, absolutePath)
    await rm(stagingDir, { recursive: true, force: true })
  } catch (error: unknown) {
    /* v8 ignore next -- abort-mid-write needs a writeFile/signal race; the non-abort (rename/open) side is tested. */
    let failure: unknown = isAbortError(error) ? new FsError('write aborted', 'FS_ABORTED') : error
    /* v8 ignore next 8 -- reached only if writeFile/sync throws with the handle open (IO fault); close-failure is a double fault. */
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new FsError(`write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`, 'FS_NOT_FOUND', { cause: failure })
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure)
  }
}

// --- Editing ---

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Read and decode a file for editing: rejects binaries, returns LF-normalized
 * content plus the original line-ending style for write-back.
 */
export async function readForEdit(
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFile(absolutePath, signal ? { signal } : {})
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = buffer.toString('utf8')
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * Apply a literal replacement to LF-normalized content. Throws
 * `FS_EDIT_NOT_FOUND` on empty `oldString` or zero matches and
 * `FS_AMBIGUOUS_EDIT` on multiple matches when `replaceAll` is false. Returns
 * the edited content (still LF-normalized) and the replacement count.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

export { restoreLineEndings }
