/**
 * Cordis-free local-filesystem I/O for `@deepseek-ai/dsh-fs-local`. Kept
 * separate from the service class (mirroring `dsh-bash-local`'s `run.ts`) so
 * the raw stat/read/write/edit mechanics can be unit-tested without a Context.
 *
 * This is the PROVIDER layer: it hands back decoded whole-file text (validated
 * UTF-8, binary rejected) — never line windows or numbered lines, which are
 * model-facing read policy owned by `@deepseek-ai/dsh-fs-policy`. Large files
 * stream their text in chunks so a huge file never has to be held whole in
 * memory; the binary/NUL sample and cross-chunk UTF-8 decoding stay here.
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
import { TextDecoder } from 'node:util'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

/** Files at or above this size stream their text; smaller files read whole. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

const BINARY_SAMPLE_BYTES = 8192

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * A path component that is expected to be a directory is a regular file (e.g.
 * resolving `afile/child.txt` when `afile` is a file). Like `ENOENT`, the target
 * cannot exist — so the resolution/probe paths treat it as "absent" rather than
 * letting a raw Node error escape without the structured `FsError` taxonomy.
 */
function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
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

/**
 * `readFile` with the supplied signal, translating a mid-read `AbortError` into
 * the seam's structured `FsError('FS_ABORTED')` (Node rejects an aborted
 * `readFile` with a bare `AbortError`, which would otherwise escape the seam's
 * error taxonomy — the streaming/write paths translate it the same way).
 */
async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-abort readFile rejection needs a permission/IO fault racing an open file. */
    if (!isAbortError(error)) throw error
    throw new FsError(`${verb} aborted`, 'FS_ABORTED')
  }
}

/** Opaque version token from a stat: mtime (ns precision) + size. */
function versionOf(info: Stats): FsVersion {
  return FsVersion(`${info.mtimeMs}:${info.size}`)
}

/**
 * Test seam: lets specs force the streaming read path (via a small
 * `streamMinSize`) and pin the temp-file name (to prove exclusive-open
 * behavior) without a 10 MB fixture or a name race.
 */
export interface FsIoInternals {
  /** Override {@link STREAM_MIN_SIZE} for read routing. */
  streamMinSize?: number
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
  targetKey: FsTargetKey
}

/** Result of probing a path: null when it does not exist. */
export interface PathInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/**
 * Resolve a path to its absolute display path and realpath identity. Relative
 * paths are based on `cwd`. When the file itself does not yet exist, the
 * `targetKey` realpaths the nearest EXISTING ancestor directory and re-appends
 * the still-missing suffix, so a not-yet-created file gets the same stable key
 * it will have after creation — even when an ancestor (e.g. `cwd`) is a symlink
 * and intermediate directories are created by the write. Two input paths
 * reaching the same file via symlinks share one key. Falls back to the absolute
 * path only when no ancestor (not even the filesystem root) can be resolved.
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    // Prefer the file's own realpath (resolves a symlinked file to its target).
    return { displayPath, targetKey: FsTargetKey(await realpath(displayPath)) }
  } catch (error: unknown) {
    // A path component is a file, not a directory (e.g. "afile/child.txt" where
    // "afile" is a regular file): the target can neither exist nor be created,
    // so surface the structured taxonomy instead of a raw Node ENOTDIR.
    if (isENOTDIR(error)) throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    /* v8 ignore next -- non-ENOENT realpath failure needs a permission/IO fault; ENOENT falls through to ancestor resolution. */
    if (!isENOENT(error)) throw error
  }
  // File absent: realpath the nearest existing ancestor and re-append the
  // missing suffix (the file basename plus any not-yet-created intermediate
  // dirs), so the key is stable across creation of those dirs.
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      return { displayPath, targetKey: FsTargetKey(join(realAncestor, ...missing)) }
    } catch (error: unknown) {
      /* v8 ignore next -- a non-ENOENT realpath failure needs a permission/IO fault. */
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      /* v8 ignore next -- the filesystem root always realpaths, so the walk terminates before parent === ancestor. */
      if (parent === ancestor) return { displayPath, targetKey: FsTargetKey(displayPath) }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Probe a path for its version, mode, type, and size. Null if absent. */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  try {
    const info = await stat(absolutePath)
    const type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
    return { version: versionOf(info), mode: info.mode & 0o777, type, size: info.size }
  } catch (error: unknown) {
    // ENOENT (no such file) and ENOTDIR (a parent segment is a file) both mean
    // the target is absent; any other stat failure is a real permission/IO fault.
    /* v8 ignore next -- a non-ENOENT/ENOTDIR stat failure needs a permission/IO fault; surface it. */
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

// --- Reading ---

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

async function statRegularFile(target: LocalTarget, verb: 'read', signal?: AbortSignal): Promise<Stats> {
  throwIfAborted(signal, verb)
  let info: Stats
  try {
    info = await stat(target.targetKey)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; only the not-found path is reachable in tests. */
    if (!isENOENT(error)) throw error
    throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/**
 * Read a whole regular UTF-8 text file into a single decoded string. Rejects
 * non-regular files, invalid UTF-8, and NUL-byte binary samples.
 */
export async function readWholeText(target: LocalTarget, signal?: AbortSignal): Promise<string> {
  await statRegularFile(target, 'read', signal)
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return decodeUtf8(raw, 'read', target.displayPath)
}

/**
 * Stream a whole regular UTF-8 text file as decoded text chunks. Same text
 * semantics as {@link readWholeText} (regular-file check, binary/NUL rejection,
 * cross-chunk UTF-8 decoding), but never holds the whole file in memory.
 */
export async function* streamWholeText(target: LocalTarget, signal?: AbortSignal): AsyncIterable<string> {
  await statRegularFile(target, 'read', signal)
  const stream = createReadStream(target.targetKey, signal ? { signal } : {})
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampledBytes = 0

  function scanBinarySample(chunk: Buffer): void {
    if (sampledBytes >= BINARY_SAMPLE_BYTES) return
    const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampledBytes))
    if (sample.includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    sampledBytes += sample.length
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      scanBinarySample(chunk)
      yield decodeUtf8Stream(decoder, chunk, 'read', target.displayPath)
    }
    yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
  } catch (error: unknown) {
    /* v8 ignore next 4 -- mid-stream errors need an abort/IO fault racing the loop; pre-abort is caught by throwIfAborted. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
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
  const buffer = await readFileAbortable(absolutePath, 'edit', signal)
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = decodeUtf8(buffer, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * Best-effort read of a file's current text for a before/after diff basis, used
 * by an overwrite. Returns the LF-normalized decoded content, or `null` when the
 * file is binary or not valid UTF-8 — a write must succeed regardless of the
 * prior bytes, so an undiffable prior file simply yields no contextual-hunk basis
 * (the caller treats `null` the same as an absent file: the result renders a
 * whole-file diff rather than an applied hunk).
 */
export async function readTextForDiff(absolutePath: string, signal?: AbortSignal): Promise<string | null> {
  const buffer = await readFileAbortable(absolutePath, 'read', signal)
  if (buffer.includes(0)) return null
  try {
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    return null
  }
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

export { normalizeLineEndings, restoreLineEndings }
