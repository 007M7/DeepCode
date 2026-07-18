/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session, and delegates orchestration to
 * {@link PersistenceCoordinator}. Its side-effect-free locator returns the
 * absolute per-session log target before materialization.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { open, mkdir, readFile, readdir, link, rm, stat as fsStat, truncate } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  SessionPersistence, PersistenceCoordinator,
  type PersistenceBackend, type SessionLocation, type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLine, logPath, parseHeaderMeta, scanLog, sessionDir, toHeaderLine,
} from './format.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'

/** Plugin config: where the JSONL backend keeps its session logs (`root` is required — no default). */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under per-cwd subdirectories.
   */
  root: string
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the byte offset to truncate the log to.
 */
export class SessionPersistenceJsonl extends SessionPersistence implements PersistenceBackend<number> {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().required(),
  })

  /**
   * Backend label for coordinator diagnostics and effects. It shadows
   * `Service.name` without changing the service key captured by the base
   * constructor.
   */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this)
  }

  // Each backend keeps the typed service surface beside its storage hooks;
  // extracting these trivial forwards would add an inheritance seam.
  /* jscpd:ignore-start */
  // --- SessionPersistence service surface (delegated to the coordinator) ---

  /** Resolve the absolute target path without touching the filesystem. */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id) }
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
  async loadStored(id: SessionId): Promise<StoredPrefix<number> | undefined> {
    const file = await this.findLog(id)
    if (file === undefined) return undefined
    return this.readPrefix(file.path)
  }

  /**
   * Read a stored prefix within one cwd for HMR adoption. `undefined` names the
   * no-cwd bucket rather than an unknown cwd, so this never scans other buckets.
   */
  async loadLive(id: SessionId, cwd: string | undefined): Promise<StoredPrefix<number> | undefined> {
    const path = logPath(this.root, cwd, id)
    if (!await this.exists(path)) return undefined
    return this.readPrefix(path)
  }

  /**
   * Read a stored prefix and convert torn-tail state to the byte offset the
   * coordinator can round-trip without knowing the file format.
   */
  private async readPrefix(path: string): Promise<StoredPrefix<number>> {
    const buffer = await readFile(path)
    const { meta, events, committedBytes } = scanLog(buffer)
    return {
      meta,
      events,
      ...committedBytes < buffer.byteLength ? { tornMarker: committedBytes } : {},
    }
  }

  /** Durably append a batch, lazily materializing the file when not yet present. */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    if (isMaterialized) {
      await this.appendLines(meta, events)
    } else {
      await this.materialize(meta, events)
    }
  }

  /**
   * Make a crash repair durable: truncate the torn tail to `tornMarker` bytes (if
   * any), then append the synthetic `closers` (if any). Two fsync'd steps — the
   * seam does not require this to be atomic.
   */
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (tornMarker !== undefined) await this.repair(meta, tornMarker)
    if (closers.length > 0) await this.appendLines(meta, closers)
  }

  /** List all stored sessions' metadata (header line only — no full-log parse). */
  async list(): Promise<SessionHeader[]> {
    const metas: SessionHeader[] = []
    for (const dir of await this.listCwdDirs()) {
      for (const name of await this.listJsonl(dir)) {
        // Read only headers so listing scales with session count, not log size.
        const first = await this.readFirstLine(`${dir}/${name}`)
        if (first === undefined) continue // empty/half-written file
        const meta = parseHeaderMeta(first)
        if (meta === undefined) continue // not a session header
        metas.push(meta)
      }
    }
    return metas
  }

  // --- materialization / append / repair (file mechanics) ---

  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const dir = sessionDir(this.root, meta.cwd)
    const finalPath = logPath(this.root, meta.cwd, meta.id)
    const content = this.initialLogContent(meta, events)
    /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      await this.materializeWin32(dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(dir, finalPath, meta.id, content)
    }
  }

  private initialLogContent(meta: SessionHeader, events: readonly SessionEvent[]): string {
    const header = JSON.stringify(toHeaderLine(meta))
    const body = events.map(eventLine).join('\n')
    return header + '\n' + body + '\n'
  }

  /* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
  private async materializePosix(dir: string, finalPath: string, id: SessionId, content: string): Promise<void> {
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
  private async materializeWin32(dir: string, finalPath: string, id: SessionId, content: string): Promise<void> {
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
    // Never publish over an existing committed log: materialize is the FIRST
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly. (createCore
    // already guards the create path, so this is unreachable-in-practice TOCTOU
    // defense.)
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: string): Promise<string> {
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
    const path = logPath(this.root, meta.cwd, meta.id)
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
        await handle.writeFile(events.map(eventLine).join('\n') + '\n')
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
    const path = logPath(this.root, meta.cwd, meta.id)
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

  /**
   * Find a session by id across cwd buckets for resume. Cwd-scoped HMR adoption
   * bypasses this scan so a no-cwd session cannot claim another bucket.
   */
  private async findLog(id: SessionId): Promise<{ path: string; cwd: string | undefined } | undefined> {
    const target = encodeSegment(id) + '.jsonl'
    for (const dir of await this.listCwdDirs()) {
      const path = `${dir}/${target}`
      if (await this.exists(path)) {
        // Recover the cwd from the header so the caller has the session's bucket.
        const { meta } = scanLog(await readFile(path))
        return { path, cwd: meta.cwd }
      }
    }
    return undefined
  }

  /** The cwd-bucket directories under the root (absolute paths). */
  private async listCwdDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => `${this.root}/${e.name}`)
    } catch (error) {
      // Only an absent root means no sessions; rethrow every other I/O failure.
      if (isENOENT(error)) return []
      throw error
    }
  }

  private async listJsonl(dir: string): Promise<string[]> {
    const entries = await readdir(dir)
    return entries.filter(n => n.endsWith('.jsonl'))
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
