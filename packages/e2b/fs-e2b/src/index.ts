/**
 * E2B implementation of the filesystem provider seam. Paths, contents, and
 * atomic staging files remain inside the shared remote sandbox.
 * @module @deepseek-ai/dsh-fs-e2b
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  CommandExitError,
  FileNotFoundError,
  FileType,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { EntryInfo, Sandbox } from '@deepseek-ai/dsh-e2b'
import { BOUNDED_READER_SOURCE } from './source-reader.ts'

const VERSION_METADATA_KEY = 'dsh-version'
const BINARY_SAMPLE_BYTES = 8192

type BoundedReadResponse =
  | { kind: 'ok'; data: string }
  | { kind: 'not-file' }
  | { kind: 'oversize'; size: number }
  | { kind: 'grew' }
  | { kind: 'open-error'; message: string }

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function entryType(entry: EntryInfo): FsInfo['type'] {
  switch (entry.type) {
    case FileType.FILE:
      return 'file'
    case FileType.DIR:
      return 'directory'
    default:
      return 'other'
  }
}

function entryVersion(entry: EntryInfo): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([
    entry.metadata?.[VERSION_METADATA_KEY],
    entry.path,
    entry.type,
    entry.size,
    entry.mode,
    entry.modifiedTime?.toISOString(),
    entry.symlinkTarget,
  ])
  return FsVersion(`e2b:${createHash('sha256').update(facts).digest('hex')}`)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (error instanceof FileNotFoundError) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|operation not permitted/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** Remote filesystem backend sharing the sandbox owned by `ctx.e2b`. */
export class E2BFileSystem extends FileSystem {
  static inject = ['e2b']

  private readonly locks = new Map<string, Promise<unknown>>()

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const targetKey = await this.canonicalPath(sandbox, displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-e2b: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const entry = await this.probe(String(target.targetKey), target.displayPath, signal)
    if (entry === undefined) return undefined
    return {
      version: entryVersion(entry),
      type: entryType(entry),
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path)
    const entry = await this.probe(displayPath, displayPath, signal)
    if (entry === undefined) return undefined
    const type = entry.symlinkTarget !== undefined
      ? 'symlink' as const
      : entry.type === FileType.FILE
        ? 'file' as const
        : entry.type === FileType.DIR
          ? 'directory' as const
          : 'other' as const
    return {
      version: entryVersion(entry),
      type,
      ...(entry.type === FileType.FILE ? { size: entry.size } : {}),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    try {
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'read')
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readTextBounded(target: FsTarget, maxBytes: number, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('bounded read maxBytes must be a positive safe integer')
    }
    assertNotAborted(signal, 'read')
    const sandbox = await this.ctx.e2b.getSandbox()
    try {
      const node = await sandbox.commands.run('command -v -- node', signalOpts(signal))
      const executable = node.stdout.trim()
      if (!posix.isAbsolute(executable) || executable.includes('\n')) {
        throw new Error('fs-e2b: bounded reader requires one absolute Node executable')
      }
      const command = [
        quoteE2BShellArg(executable),
        '--input-type=commonjs',
        '-e',
        quoteE2BShellArg(BOUNDED_READER_SOURCE),
        quoteE2BShellArg(this.processPath(target)),
        String(maxBytes),
      ].join(' ')
      const result = await sandbox.commands.run(command, signalOpts(signal))
      assertNotAborted(signal, 'read')
      const response = this.parseBoundedRead(result.stdout, target)
      if (response.kind === 'not-file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (response.kind === 'oversize' && Number.isSafeInteger(response.size)) {
        throw new FsError(
          `cannot read "${target.displayPath}": ${response.size} bytes exceeds the ${maxBytes}-byte limit`,
          'FS_IO_ERROR',
        )
      }
      if (response.kind === 'grew') {
        throw new FsError(
          `cannot read "${target.displayPath}": file grew past the ${maxBytes}-byte limit while reading`,
          'FS_IO_ERROR',
        )
      }
      if (response.kind === 'open-error' && typeof response.message === 'string') {
        if (/ENOENT|no such file/i.test(response.message)) {
          throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
        }
        if (/EACCES|EPERM|permission denied|operation not permitted/i.test(response.message)) {
          throw new FsError(`cannot read "${target.displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
        }
        throw new FsError(
          `cannot read "${target.displayPath}" safely: ${response.message}`,
          'FS_IO_ERROR',
        )
      }
      if (response.kind !== 'ok' || typeof response.data !== 'string') {
        throw new FsError(`cannot read "${target.displayPath}": bounded reader returned an invalid response`, 'FS_IO_ERROR')
      }
      const bytes = Buffer.from(response.data, 'base64')
      if (bytes.toString('base64') !== response.data || bytes.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": bounded reader returned invalid bytes`, 'FS_IO_ERROR')
      }
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const sandbox = await this.ctx.e2b.getSandbox()
    await this.requireRegular(target, signal)
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await sandbox.files.read(String(target.targetKey), { format: 'stream', ...signalOpts(signal) })
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const reader = stream.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          while (true) {
            assertNotAborted(signal, 'read')
            const next = await reader.read()
            if (next.done) break
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(next.value, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          if (!completed) {
            try {
              await reader.cancel()
            } catch (_streamCancellationFailure) {
              // The primary read outcome owns the result; cancellation is best-effort after early stop.
            }
          }
          reader.releaseLock()
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const listed = await sandbox.files.list(String(target.targetKey), { depth: 1, ...signalOpts(signal) })
      const entries = await Promise.all(listed.map(async (entry): Promise<FsDirEntry> => {
        const displayPath = posix.join(target.displayPath, entry.name)
        const canonical = await this.canonicalPath(sandbox, entry.path, signal)
        const resolved = await this.probe(canonical, displayPath, signal)
        return {
          name: entry.name,
          type: resolved === undefined ? 'other' : entryType(resolved),
          target: { targetKey: FsTargetKey(canonical), displayPath },
          ...(resolved !== undefined ? { version: entryVersion(resolved) } : {}),
          ...(resolved?.type === FileType.FILE ? { size: resolved.size } : {}),
        }
      }))
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && entryType(existing) !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, existing, signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async canonicalPath(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await sandbox.commands.run(`realpath -m -- ${quoteE2BShellArg(path)}`, signalOpts(signal))
      return result.stdout.replace(/\n$/, '')
    } catch (error: unknown) {
      if (error instanceof CommandExitError) throw new Error(error.stderr || error.message, { cause: error })
      throw error
    }
  }

  private parseBoundedRead(stdout: string, target: FsTarget): BoundedReadResponse {
    try {
      return JSON.parse(stdout) as BoundedReadResponse
    } catch (error: unknown) {
      throw new FsError(
        `cannot read "${target.displayPath}": bounded reader returned invalid JSON`,
        'FS_IO_ERROR',
        { cause: error },
      )
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<EntryInfo | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const entry = await sandbox.files.getInfo(path, signalOpts(signal))
      assertNotAborted(signal, 'stat')
      return entry
    } catch (error: unknown) {
      if (error instanceof FileNotFoundError) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<void> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }

  private checkWriteIntent(existing: EntryInfo | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'read')
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const sandbox = await this.ctx.e2b.getSandbox()
      const bytes = await sandbox.files.read(String(target.targetKey), { format: 'bytes', ...signalOpts(signal) })
      assertNotAborted(signal, 'edit')
      return decodeText(bytes, target.displayPath, bytes.length)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: EntryInfo | undefined,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const sandbox = await this.ctx.e2b.getSandbox()
    const targetPath = String(target.targetKey)
    const versionId = randomUUID()
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      const created = await sandbox.files.makeDir(stagingDirectory, signalOpts(signal))
      if (!created) throw new Error('private staging directory already exists')
      stagingDirectoryCreated = true
      await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stagingDirectory)}`, signalOpts(signal))
      assertNotAborted(signal, 'write')
      await sandbox.files.write(temporary, content, {
        metadata: { [VERSION_METADATA_KEY]: versionId },
        ...signalOpts(signal),
      })
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await sandbox.commands.run(
        `chmod ${mode.toString(8)} -- ${quoteE2BShellArg(temporary)}`,
        signalOpts(signal),
      )
      assertNotAborted(signal, 'write')
      const committed = await sandbox.files.rename(temporary, targetPath, signalOpts(signal))
      try {
        await sandbox.files.remove(stagingDirectory)
      } catch (_committedStagingCleanupFailure) {
        // The target is already committed; an empty private directory cannot turn that write into a failure.
      }
      return entryVersion(committed)
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        try {
          await sandbox.files.remove(stagingDirectory)
        } catch (_stagingDirectoryAlreadyAbsentOrCleanupFailed) {
          // Only the private staging directory is swallowed; the original failure owns the operation.
        }
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

export default E2BFileSystem
