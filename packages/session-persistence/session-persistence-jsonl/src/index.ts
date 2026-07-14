/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session, and delegates orchestration to
 * {@link PersistenceCoordinator}.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { open, mkdir, readFile, readdir, link, rm, truncate } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  SessionPersistence, PersistenceCoordinator,
  type PersistenceBackend, type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLine, logPath, parseHeaderMeta, scanLog, sessionDir, toHeaderLine,
} from './format.ts'

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

  /**
   * The per-session init promises, exposed for white-box tests that await a
   * specific session's onCreated (there is no public API to await one init).
   */
  get inits(): Map<Session, Promise<void>> {
    return this.coordinator.inits
  }
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

  /** Atomically write the header line + first batch (temp-write, fsync, collision-safe hard-link publish). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const dir = sessionDir(this.root, meta.cwd)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDir(dirname(this.root))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDir(this.root)
    const finalPath = logPath(this.root, meta.cwd, meta.id)
    // Materialization is the first write; an existing log is an id collision.
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${meta.id}": a log already exists on disk (load/resume it instead)`)
    }
    const header = JSON.stringify(toHeaderLine(meta))
    const body = events.map(eventLine).join('\n')
    const content = header + '\n' + body + '\n'

    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Publish with link()+unlink(): unlike rename(), link fails if another
    // process materialized the same id first.
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
    // The published link becomes crash-durable only after its directory fsync.
    await this.syncDir(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a failure to
    // remove the (now-redundant) temp hard link must not reject the append.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }

  /** fsync a directory so a just-created or published entry inside it is crash-durable. */
  private async syncDir(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Append and fsync event lines. On a partial write or sync failure, restore the
   * previous size before rethrowing because the unchanged cursor will retry the
   * batch; leaving partial bytes would create duplicate sequence numbers.
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id)
    const handle = await open(path, 'a')
    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(events.map(eventLine).join('\n') + '\n')
        await handle.sync()
      } catch (error) {
        // Roll back whatever bytes landed so a retry starts from a clean EOF.
        await handle.truncate(before)
        await handle.sync()
        throw error
      }
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
      // Only ENOENT means absent. A permission/I/O error must surface, not be
      // collapsed to `false` — otherwise load() reports "not found" and collision
      // checks proceed under a false absence assumption.
      if (isENOENT(error)) return false
      throw error
    }
  }
}

export default SessionPersistenceJsonl
