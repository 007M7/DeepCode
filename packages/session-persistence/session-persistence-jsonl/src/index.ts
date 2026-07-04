/**
 * JSONL durable session-persistence backend (`@deepseek-ai/dsh-session-persistence-jsonl`).
 *
 * One append-only `.jsonl` event log per session (a header line then one
 * `SessionEvent` per line, verbatim including `assistant/chunk` so `seq` stays
 * contiguous), with lazy materialization (no file until the first `append`),
 * atomic first write, and load-time repair of a never-committed crash tail.
 *
 * The backend supplies ONLY the file-bytes storage primitives (the
 * {@link PersistenceBackend} hooks below); all the write-path orchestration
 * (the `session/event` → buffer → `session/flush` drain, per-session
 * serialization, write cursors, fork-seed persistence, HMR live-adoption,
 * crash-repair sequencing, dispose quiescence) lives in the backend-agnostic
 * {@link PersistenceCoordinator} this class composes. The four public
 * {@link SessionPersistence} methods delegate to the coordinator.
 *
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

export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under per-cwd subdirectories.
   */
  root: string
}

/**
 * Whether `error` is a "no such file/directory" (`ENOENT`) failure — the ONLY
 * filesystem error that legitimately means "this session/root is absent" for a
 * durable backend. Any OTHER error (`EACCES`, `ENOTDIR`, transient I/O) must
 * surface rather than be silently reported as absence. (A NodeJS filesystem
 * rejection carries a string `code`.)
 */
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
   * Backend label for the coordinator's dispose-failure AggregateError and
   * effect name. NOTE: this intentionally shadows cordis `Service.name` (which
   * the base sets to `'sessionPersistence'`). The service is registered under the
   * fixed key the Service constructor captured (`reflect.provide('sessionPersistence', …)`),
   * not via `this.name`, so overwriting the instance field with the backend label
   * does not affect `ctx.sessionPersistence` resolution — it only relabels the
   * dispose diagnostics, which is exactly what {@link PersistenceBackend.name} is for.
   */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve the configured root to an ABSOLUTE path ONCE, here. A relative root
    // would otherwise re-resolve against `process.cwd()` at every later
    // readdir/open — so if any plugin or test changed cwd between create, append,
    // and load, one session's files could split across directories.
    this.root = resolve(config.root)
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this)
  }

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

  // `list` is BOTH the public service method and the PersistenceBackend hook —
  // one method, the bucket walk below. The coordinator adds no orchestration for
  // listing (no per-id serialization, no cursor), so it would just call back into
  // this same method; routing it through the coordinator would recurse. Defined
  // once, in the "PersistenceBackend hooks" section.

  /**
   * The per-session init promises, exposed for white-box tests that await a
   * specific session's onCreated (there is no public API to await one init).
   */
  get inits(): Map<Session, Promise<void>> {
    return this.coordinator.inits
  }

  // --- PersistenceBackend hooks (the file-bytes storage primitives) ---

  /** Read a stored prefix by id across ALL cwd buckets (cwd unknown). */
  async loadStored(id: SessionId): Promise<StoredPrefix<number> | undefined> {
    const file = await this.findLog(id)
    if (file === undefined) return undefined
    return this.readPrefix(file.path)
  }

  /**
   * Read a stored prefix SCOPED to `cwd` (HMR live-adoption must not cross cwd).
   * `undefined` is the DEFINITE "no-cwd" bucket, NOT "unknown" — a live session
   * with no cwd may only adopt a persisted no-cwd log, never a same-id log that
   * lives in some other cwd bucket. So this looks at exactly `logPath(cwd)`
   * (which maps `undefined` → the `_no-cwd` bucket), never the all-buckets scan.
   */
  async loadLive(id: SessionId, cwd: string | undefined): Promise<StoredPrefix<number> | undefined> {
    const path = logPath(this.root, cwd, id)
    if (!await this.exists(path)) return undefined
    return this.readPrefix(path)
  }

  /**
   * Read and scan a session's log file into a {@link StoredPrefix}. Folds the
   * torn-tail comparison HERE so the `tornMarker` is the byte offset to truncate
   * to (or `undefined` when nothing is torn) — the coordinator never sees the
   * raw byteLength.
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
        // Read ONLY the header line, not the whole log: a session picker must
        // scale with the number of sessions, not the total size of every
        // conversation (the log persists every assistant/chunk verbatim).
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

  /** Atomically write the header line + first batch (temp-write, fsync, rename). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const dir = sessionDir(this.root, meta.cwd)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDir(dirname(this.root))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDir(this.root)
    const finalPath = logPath(this.root, meta.cwd, meta.id)
    // Never rename over an existing committed log: materialize is the FIRST write
    // of a session the backend believes is new. A file here means a different
    // session shares this id on disk — reject loudly. (createCore already guards
    // the create path, so this is unreachable-in-practice TOCTOU defense.)
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
    // Publish via link()+unlink(), NOT rename(): link fails with EEXIST if the
    // final path already exists, so two processes materializing the same id
    // concurrently cannot clobber each other. rename() would silently overwrite.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // If link FAILED, the temp is the only reference and must be removed before
      // the original error propagates. If it SUCCEEDED, defer temp cleanup to
      // AFTER the publish is durable (below) so a temp-rm failure can never reject
      // a session whose log already published.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: the new link is not crash-durable until the
    // parent directory's metadata is synced.
    await this.syncDir(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the (now-redundant) temp hard link must NOT reject the
    // append. Swallow only the rm failure; nothing else of consequence runs here.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }

  /** fsync a directory so a just-created/renamed entry inside it is crash-durable. */
  private async syncDir(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Append event lines at EOF and fsync. On a write/sync failure AFTER the kernel
   * accepted some bytes (ENOSPC, an fsync error), truncate the file back to its
   * pre-append size before rethrowing: the cursor is unchanged, so the batch will
   * be retried, and without this rollback the retry would append AFTER the partial
   * bytes — producing duplicate seqs that make `scanLog` see a gap.
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
   * Find a session's log file by id across ALL cwd buckets — the any-cwd scan
   * for `loadStored` (resume identifies a session by id alone). The cwd-scoped
   * lookup (`loadLive`) does NOT use this; it goes straight to `logPath(cwd)` so
   * a no-cwd session can't match a real-cwd bucket.
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
      // ENOENT = the root has not been created yet → genuinely no sessions. Any
      // other error (EACCES, ENOTDIR, transient I/O) must NOT be reported as "no
      // sessions" — a durable backend cannot silently pretend state is absent.
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
