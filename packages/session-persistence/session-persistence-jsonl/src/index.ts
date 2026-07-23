/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session, and delegates orchestration to
 * {@link PersistenceCoordinator}. Its side-effect-free locator returns the
 * absolute per-session log target before materialization.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { readdirSync } from 'node:fs'
import { open, mkdir, readFile, readdir, link, rm, stat as fsStat, truncate } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  SessionPersistence, PersistenceCoordinator,
  type PersistenceBackend, type SessionLocation, type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLines, logPath, logSuffix, parseHeaderMeta, scanLog, sessionDir, toHeaderLine,
  type JsonlCompression,
} from './format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from './zstd.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'

export type { JsonlCompression } from './format.ts'

const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'

/** Loader schema for the JSONL artifact's physical encoding. */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** Plugin config: where the JSONL backend keeps its session logs, and the packed-row write switch. */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under per-cwd subdirectories. An
   * existing root must be a readable directory; an absent root is created on
   * first materialization.
   */
  root: string
  /**
   * Write runs of consecutive `assistant/chunk` delta events as packed
   * `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows (lossless,
   * ~60% smaller logs measured on a real session). Off by default while
   * snapshot fixtures stay in the one-event-per-line layout: recording with
   * packing on rewrites every golden `session.jsonl`. READING packed rows is
   * unconditional — a log's layout never depends on this switch.
   */
  packChunks?: boolean
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
}

/** Opaque coordinator token for replacing bytes recovered from a torn frame. */
interface JsonlTornMarker {
  truncateTo: number
  recoveredEvents: SessionEvent[]
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker carries the byte offset and any events
 * recovered from an incomplete final Zstandard frame.
 */
export class SessionPersistenceJsonl extends SessionPersistence implements PersistenceBackend<JsonlTornMarker> {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    packChunks: z.boolean().default(false),
    compression: JsonlCompressionSchema,
  })

  /**
   * Backend label for coordinator diagnostics and effects. It shadows
   * `Service.name` without changing the service key captured by the base
   * constructor.
   */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private packChunks: boolean
  private compression: JsonlCompression
  private coordinator: PersistenceCoordinator<JsonlTornMarker>
  private rootEncodingCheck: Promise<void> | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    // schemastery (static Config) applied the default before construction;
    // the cast records that runtime fact for exactOptionalPropertyTypes.
    this.packChunks = (config as Required<Config>).packChunks
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.assertUsableRoot()
    this.coordinator = new PersistenceCoordinator<JsonlTornMarker>(this.ctx, this)
  }

  // Each backend keeps the typed service surface beside its storage hooks;
  // extracting these trivial forwards would add an inheritance seam.
  /* jscpd:ignore-start */
  // --- SessionPersistence service surface (delegated to the coordinator) ---

  /** Resolve the absolute target path without touching the filesystem. */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  /* jscpd:ignore-end */
  // --- PersistenceBackend hooks (the file-bytes storage primitives) ---

  /** Read a stored prefix by id across all cwd buckets when cwd is unknown. */
  async loadStored(id: SessionId): Promise<StoredPrefix<JsonlTornMarker> | undefined> {
    await this.ensureRootEncoding()
    const path = await this.findLog(id)
    if (path === undefined) return undefined
    return this.readPrefix(path, id)
  }

  /**
   * Read a stored prefix and convert torn-tail state to the opaque marker the
   * coordinator can round-trip without knowing the physical encoding.
   */
  private async readPrefix(path: string, expectedId?: SessionId): Promise<StoredPrefix<JsonlTornMarker>> {
    const buffer = await readFile(path)
    let prefix: StoredPrefix<JsonlTornMarker>
    if (this.compression === 'zstd') {
      prefix = await this.readZstdPrefix(buffer)
    } else {
      const { meta, events, committedBytes } = scanLog(buffer)
      prefix = {
        meta,
        events,
        ...committedBytes < buffer.byteLength
          ? { tornMarker: { truncateTo: committedBytes, recoveredEvents: [] } }
          : {},
      }
    }
    this.assertStoredIdentity(path, prefix.meta, expectedId)
    return prefix
  }

  /** Decode complete frames and retain complete JSONL records from a torn final frame. */
  private async readZstdPrefix(buffer: Buffer): Promise<StoredPrefix<JsonlTornMarker>> {
    const { frames, tornStart } = scanZstdFrames(buffer)
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

    const plaintextFrames: Buffer[] = []
    for (const frame of frames) {
      try {
        plaintextFrames.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
      } catch (error) {
        throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, { cause: error })
      }
    }

    const headerFrame = plaintextFrames[0]
    if (headerFrame === undefined || headerFrame.length === 0 || headerFrame.indexOf(0x0A) !== headerFrame.length - 1) {
      throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
    }
    const completePlaintext = Buffer.concat(plaintextFrames)
    const completePrefix = scanLog(completePlaintext)
    if (completePrefix.committedBytes !== completePlaintext.length) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
    }
    if (tornStart === undefined) {
      return { meta: completePrefix.meta, events: completePrefix.events }
    }

    let recoveredPlaintext: Buffer = Buffer.alloc(0)
    try {
      recoveredPlaintext = await decompressZstdFrame(buffer.subarray(tornStart))
    } catch {
      // A structurally incomplete final frame may end before Node's decoder can
      // emit any plaintext; the complete prior frames remain recoverable.
    }
    const recoveredPrefix = scanLog(Buffer.concat([completePlaintext, recoveredPlaintext]))
    /* v8 ignore next 3 -- appending plaintext cannot shorten the already-scanned complete prefix */
    if (recoveredPrefix.events.length < completePrefix.events.length) {
      throw new Error('corrupt Zstandard session log: recovered prefix does not extend complete frames')
    }
    return {
      meta: recoveredPrefix.meta,
      events: recoveredPrefix.events,
      tornMarker: {
        truncateTo: tornStart,
        recoveredEvents: recoveredPrefix.events.slice(completePrefix.events.length),
      },
    }
  }

  /** Durably append a batch, lazily materializing the file when not yet present. */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(meta, events)
    } else {
      await this.materialize(meta, events)
    }
  }

  /**
   * Make a crash repair durable: truncate a torn tail, restore complete events
   * decoded from it, then append synthetic closers. Two fsync'd steps — the seam
   * does not require this to be atomic.
   */
  async commitRepair(
    meta: SessionHeader,
    tornMarker: JsonlTornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) await this.repair(meta, tornMarker.truncateTo)
    const repairedEvents = [...(tornMarker?.recoveredEvents ?? []), ...closers]
    if (repairedEvents.length > 0) await this.appendLines(meta, repairedEvents)
  }

  /** List valid unique stored sessions' metadata (header line only — no full-log parse). */
  async list(): Promise<SessionHeader[]> {
    await this.ensureRootEncoding()
    const metas: SessionHeader[] = []
    const ids = new Set<SessionId>()
    for (const dir of await this.listCwdDirs()) {
      for (const name of await this.listArtifacts(dir)) {
        const path = join(dir, name)
        // Read only headers so listing scales with session count, not log size.
        const first = this.compression === 'zstd'
          ? await this.readFirstZstdLine(path)
          : await this.readFirstLine(path)
        if (first === undefined) continue // empty/half-written file
        const meta = parseHeaderMeta(first)
        if (meta === undefined) continue // not a session header
        this.assertStoredIdentity(path, meta)
        if (ids.has(meta.id)) {
          throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple cwd buckets`)
        }
        ids.add(meta.id)
        metas.push(meta)
      }
    }
    return metas
  }

  // --- materialization / append / repair (file mechanics) ---

  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const dir = sessionDir(this.root, meta.cwd)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
    const content = await this.encodeMaterialization(meta, events)
    /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      await this.materializeWin32(dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(dir, finalPath, meta.id, content)
    }
  }

  /* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
  private async materializePosix(
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(dirname(this.root))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(this.root)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    // Publish via link()+unlink(), NOT rename(): link fails with EEXIST if the
    // final path already exists, so two processes materializing the same id
    // concurrently cannot clobber each other. rename() would silently overwrite.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // Remove an unpublished temp on failure. After publication, defer cleanup
      // until the directory entry is durable so cleanup cannot reject a live log.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: the new link is not crash-durable until the
    // parent directory's metadata is synced.
    await this.syncDirPosix(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the (now-redundant) temp hard link must NOT reject the
    // append. Swallow only the rm failure; nothing else of consequence runs here.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }
  /* v8 ignore stop */

  /* v8 ignore start -- native Windows coverage exercises this integration path */
  private async materializeWin32(
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await ensureDurableDirectoryWin32(this.root)
    await ensureDurableDirectoryWin32(dir)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    try {
      await publishNewFileWin32(tmp, finalPath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  /* v8 ignore stop */

  private async rejectExistingLog(finalPath: string, id: SessionId): Promise<void> {
    // Never publish over an existing committed log: materialize is the first
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly. (createCore
    // already guards the create path, so this is unreachable-in-practice TOCTOU
    // defense.)
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: Buffer | string): Promise<string> {
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  }

  /** Encode the header and first batch without combining their frame boundaries. */
  private async encodeMaterialization(meta: SessionHeader, events: readonly SessionEvent[]): Promise<Buffer | string> {
    const header = JSON.stringify(toHeaderLine(meta)) + '\n'
    const body = eventLines(events, this.packChunks) + '\n'
    if (this.compression === 'none') return header + body
    const headerFrame = await compressZstdFrame(header)
    const eventFrame = await compressZstdFrame(body)
    return Buffer.concat([headerFrame, eventFrame])
  }

  /** Encode one durable append batch in the configured physical representation. */
  private async encodeEventBatch(events: readonly SessionEvent[]): Promise<Buffer | string> {
    const body = eventLines(events, this.packChunks) + '\n'
    return this.compression === 'zstd' ? compressZstdFrame(body) : body
  }

  /** fsync a POSIX directory so a just-created/renamed entry is crash-durable. */
  /* v8 ignore start -- Windows uses write-through namespace operations; POSIX coverage exercises directory fsync. */
  private async syncDirPosix(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /* v8 ignore stop */

  /**
   * Append and fsync event lines. On a partial write or sync failure, restore the
   * previous size before rethrowing because the unchanged cursor will retry the
   * batch; leaving partial bytes would create duplicate sequence numbers.
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const content = await this.encodeEventBatch(events)
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }

    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  private async rollbackAppend(path: string, size: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- discovery helpers ---

  /**
   * Read the first newline-terminated line of a file without loading the whole
   * file. Returns undefined if the file is empty or has no complete first line.
   * Reads in bounded chunks so a huge log costs only the header read.
   */
  private async readFirstLine(path: string): Promise<string | undefined> {
    const handle = await open(path, 'r')
    try {
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(8192)
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null)
        if (bytesRead === 0) return undefined // EOF with no newline → no complete line
        const slice = buf.subarray(0, bytesRead)
        const nl = slice.indexOf(0x0a)
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl))
          return Buffer.concat(chunks).toString('utf8')
        }
        chunks.push(Buffer.from(slice))
      }
    } finally {
      await handle.close()
    }
  }

  /** Read and validate only the independently compressed header frame. */
  private async readFirstZstdLine(path: string): Promise<string | undefined> {
    const handle = await open(path, 'r')
    try {
      let content = Buffer.alloc(0)
      const chunk = Buffer.alloc(8192)
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) return undefined
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
        const first = scanZstdFrames(content, 1).frames[0]
        if (first === undefined) continue
        let plaintext: Buffer
        try {
          plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
        } catch (error) {
          throw new Error('corrupt Zstandard session log: header frame failed validation', { cause: error })
        }
        if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
          throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
        }
        return plaintext.subarray(0, -1).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  }

  /** Find the unique physical log for an id across every cwd bucket. */
  private async findLog(id: SessionId): Promise<string | undefined> {
    const target = encodeSegment(id) + logSuffix(this.compression)
    const oppositeTarget = encodeSegment(id) + logSuffix(this.oppositeCompression())
    const matches: string[] = []
    for (const dir of await this.listCwdDirs()) {
      const path = join(dir, target)
      const opposite = join(dir, oppositeTarget)
      if (await this.exists(opposite)) throw this.encodingMismatch(opposite)
      if (await this.exists(path)) matches.push(path)
    }
    if (matches.length > 1) {
      throw new Error(`duplicate JSONL session id "${id}" appears in multiple cwd buckets`)
    }
    return matches[0]
  }

  /** Require an existing configured root to be a readable directory. */
  private assertUsableRoot(): void {
    try {
      readdirSync(this.root)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  /** Reject metadata that does not identify the selected physical log. */
  private assertStoredIdentity(path: string, meta: SessionHeader, expectedId?: SessionId): void {
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    let expectedPath: string
    try {
      expectedPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path !== expectedPath) {
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd belong at "${expectedPath}"`)
    }
  }

  /** The cwd-bucket directories under the root (absolute paths). */
  private async listCwdDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => join(this.root, e.name))
    } catch (error) {
      // Only an absent root means no sessions; rethrow every other I/O failure.
      if (isENOENT(error)) return []
      throw error
    }
  }

  private async listArtifacts(dir: string): Promise<string[]> {
    const entries = await readdir(dir)
    const oppositeSuffix = logSuffix(this.oppositeCompression())
    const incompatible = entries.find(name => name.endsWith(oppositeSuffix))
    if (incompatible !== undefined) throw this.encodingMismatch(`${dir}/${incompatible}`)
    const suffix = logSuffix(this.compression)
    return entries.filter(name => name.endsWith(suffix))
  }

  /** Reject a root that already belongs to the other physical encoding. */
  private ensureRootEncoding(): Promise<void> {
    this.rootEncodingCheck ??= this.checkRootEncoding()
    return this.rootEncodingCheck
  }

  private async checkRootEncoding(): Promise<void> {
    const oppositeSuffix = logSuffix(this.oppositeCompression())
    for (const dir of await this.listCwdDirs()) {
      const entries = await readdir(dir)
      const incompatible = entries.find(name => name.endsWith(oppositeSuffix))
      if (incompatible !== undefined) throw this.encodingMismatch(`${dir}/${incompatible}`)
    }
  }

  private async rejectOppositeArtifact(cwd: string | undefined, id: SessionId): Promise<void> {
    const path = logPath(this.root, cwd, id, this.oppositeCompression())
    if (await this.exists(path)) throw this.encodingMismatch(path)
  }

  private oppositeCompression(): JsonlCompression {
    return this.compression === 'zstd' ? 'none' : 'zstd'
  }

  private encodingMismatch(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, `
      + `but this backend is configured for compression ${JSON.stringify(this.compression)}; `
      + 'use a separate root or select the matching compression mode',
    )
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return true
    } catch (error) {
      // Only ENOENT means absent. A permission/I/O error must surface rather
      // than letting load or collision checks proceed under false absence.
      // Windows reports ENOENT, not ENOTDIR, for `regular-file/child`; verify
      // the immediate parent so a blocked cwd bucket remains a storage fault.
      /* v8 ignore else -- Windows reports file-valued parents as ENOENT; POSIX covers direct ENOTDIR. */
      if (isENOENT(error)) {
        await this.assertLogParentAllowsAbsence(path)
        return false
      }
      /* v8 ignore next -- Windows repairs ENOTDIR from ENOENT above; POSIX covers direct ENOTDIR. */
      throw error
    }
  }

  /* v8 ignore start -- native Windows coverage exercises this repair; POSIX open reports ENOTDIR before this point. */
  private async assertLogParentAllowsAbsence(path: string): Promise<void> {
    try {
      const parent = dirname(path)
      const info = await fsStat(parent)
      if (info.isDirectory()) return
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`) as NodeJS.ErrnoException
      error.code = 'ENOTDIR'
      error.path = parent
      throw error
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }
  /* v8 ignore stop */
}

export default SessionPersistenceJsonl
