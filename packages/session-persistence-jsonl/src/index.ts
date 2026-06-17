/**
 * JSONL durable session-persistence backend (`@deepseek-ai/dsh-session-persistence-jsonl`).
 *
 * Two concerns in one plugin:
 *
 * 1. **The backend** — a concrete {@link SessionPersistence}: one append-only
 *    `.jsonl` event log per session (a header line then one `SessionEvent` per
 *    line, verbatim including `assistant/chunk` so `seq` stays contiguous) plus
 *    a small atomic `.summary.json` sidecar for the mutable `SessionSummary`.
 *    Lazy materialization (no file until the first `append`), atomic first
 *    write, and truncation-repair of a never-committed crash tail on the first
 *    `append` after a `load`.
 *
 * 2. **The write path** — the `session/event` → buffer → `session/flush` drain
 *    that generalizes the example `session-jsonl.ts`: snapshot each event when
 *    it is buffered (the live `session.events` object is mutable), persist
 *    forks once on `session/created`, maintain a per-session write cursor so a
 *    resumed session never re-appends already-stored events, and seed existing
 *    live sessions on plugin apply (HMR does not replay `session/created`).
 *
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { open, mkdir, readFile, readdir, rename, link, rm, truncate } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { isJsonValue, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionMeta, SessionSummary } from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLine, logPath, parseHeaderMeta, scanLog, sessionDir, sidecarPath, toHeaderLine,
} from './format.ts'

export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under per-cwd subdirectories.
   */
  root: string
}

/** Per-session write state held by the backend's in-memory bookkeeping. */
interface SessionState {
  meta: SessionMeta
  /** The next seq the backend expects to append (the stored log length). */
  cursor: number
  /** Whether the `.jsonl` file has been physically materialized. */
  materialized: boolean
  /**
   * The live Session this state was bound to via `onCreated`, if any. Used to
   * detect a DIFFERENT live session reusing a tracked id (a collision): state
   * created through the public `create()`/`load()` API has no owner, but state
   * bound to a live session lets `onCreated` reject a second, unrelated session
   * object on the same id instead of silently no-opping (which would leave the
   * new session's events to be dropped against the old cursor).
   */
  owner?: Session
}

/**
 * Whether a live session's `seed` reproduces a persisted `prefix` exactly — the
 * prefix is no longer than the seed, and each prefix event DEEP-equals the seed
 * event at the same index. Used to tell a session legitimately continuing a
 * persisted log (HMR re-seeing its own session, or a resume) from a different
 * session that merely reuses the id: the latter would have its already-counted
 * seq 0..prefix-1 events filtered out on flush and its conversation silently
 * grafted onto the old log.
 *
 * The comparison is a full structural equality (via canonical JSON) of each
 * event INCLUDING its `data` payload, not just `seq`/`type`/`time` — a session
 * built from loaded events but with mutated message/tool payloads (same seq/
 * type/time) must NOT be accepted, or the live history and durable log diverge.
 * Both sides are JSON-serializable by contract (Session.append enforces it), so
 * JSON.stringify is a sound canonical form here.
 */
function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return prefix.length <= seed.length
    && prefix.every((e, i) => {
      const s = seed[i]
      return s !== undefined && JSON.stringify(s) === JSON.stringify(e)
    })
}

/**
 * Reject non-JSON-serializable `event.data`, naming the offending type. Used on
 * the backend's `append(events)` entry point (replay/fork paths that bypass a
 * live `Session`); events that flow through `Session.append` are already
 * validated at the source, so the live write path never needs this.
 */
function assertSerializable(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (!isJsonValue(event.data)) {
      throw new Error(`event "${event.type}" carries non-JSON-serializable data (seq ${event.seq})`)
    }
  }
}

/**
 * Whether `error` is a "no such file/directory" (`ENOENT`) failure — the ONLY
 * filesystem error that legitimately means "this session/root is absent" for a
 * durable backend. Any OTHER error (`EACCES`, `ENOTDIR`, transient I/O) must
 * surface rather than be silently reported as absence: masking it would let
 * `list()` report no sessions, `load()` report "not found", and collision
 * checks proceed under a false absence assumption — all unsafe for durable
 * persistence. (A NodeJS filesystem rejection carries a string `code`.)
 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and installs the write-path listeners.
 */
export class SessionPersistenceJsonl extends SessionPersistence {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().required(),
  })

  private root: string
  /** Backend bookkeeping keyed by session id (NOT the live Session object). */
  private states = new Map<string, SessionState>()
  /** Write-behind buffers keyed by the live Session (write path). */
  private buffers = new Map<Session, SessionEvent[]>()
  /**
   * Per-session serialization: every backend operation chains onto the prior
   * one for the same id, so concurrent flushes / a flush racing onCreated never
   * interleave file writes or read a half-built state. Keyed by session id.
   */
  private chains = new Map<string, Promise<unknown>>()
  /**
   * Per-session init promise (onCreated). Keyed by the LIVE Session OBJECT, not
   * its id: a disposed fiber's session can be replaced by a different live
   * Session reusing the same id (HMR, an ACP reconnect), and an id-keyed cache
   * would hand the new object the old object's init promise — skipping
   * onCreated for the new session, so its events start at seq 0 while flush
   * filters against the stale cursor and silently drops them. Keying by object
   * gives each live Session its own init. flush awaits it before appending.
   */
  private inits = new Map<Session, Promise<void>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Resolve the configured root to an ABSOLUTE path ONCE, here. A relative
    // root (the examples use `./.sessions`) would otherwise re-resolve against
    // `process.cwd()` at every later readdir/open — so if any plugin or test
    // changed cwd between create, append, and load, one session's files could
    // split across directories. Pinning it at construction makes all paths
    // stable regardless of later cwd changes.
    this.root = resolve(config.root)
    this.installWritePath()
  }

  // --- SessionPersistence backend surface (all serialized per session id) ---

  create(meta: SessionMeta): Promise<void> {
    // Snapshot the metadata at call time: the op runs later (behind the
    // per-session chain) and the snapshot is also stored as the lazy state, so
    // keeping the caller's object by reference would let a later mutation of
    // `id`/`cwd` register under one key but materialize under a different
    // path/header. A shallow copy is enough — SessionMeta is a flat record.
    const snapshot: SessionMeta = { ...meta }
    return this.serialize(snapshot.id, () => this.createCore(snapshot))
  }

  private async createCore(meta: SessionMeta): Promise<void> {
    // Do NOT clobber an existing session. If we already track it, or a log
    // exists on disk under this id, refuse — the SessionId IS the identity, and
    // silently resetting state (cursor 0, materialized false) over committed
    // data would let the next append rename over the existing log.
    if (this.states.has(meta.id)) {
      throw new Error(`session "${meta.id}" already exists in this backend`)
    }
    // Scan ALL cwd buckets (pass undefined), not just meta.cwd's: load/has/adopt
    // identify a session by id alone and search every bucket, so an id already
    // persisted under a DIFFERENT cwd must still block creation here. Probing
    // only meta.cwd's bucket would let two logs share one id and make resume
    // (which picks the first matching bucket) nondeterministic.
    if (await this.findLog(meta.id, undefined) !== undefined) {
      throw new Error(`session "${meta.id}" already has a persisted log on disk; load/resume it instead of creating`)
    }
    // Pure lazy: record intent only. No file until the first append, so an
    // abandoned (never-appended) session leaves nothing on disk and stays
    // absent from has()/list().
    this.states.set(meta.id, { meta, cursor: 0, materialized: false })
  }

  /**
   * Run `op` after any in-flight operation for the same session id, so writes
   * for one session never interleave (two flushes, a flush racing a load, an
   * update racing an append). Errors do not poison the chain — the next op
   * still runs. NOTE: serialized public methods must NOT call each other (that
   * would deadlock on the same chain); they call the unserialized `*Core`
   * helpers instead.
   */
  private serialize<T>(id: SessionId, op: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const next = prior.then(op, op)
    // Keep the chain alive but swallow this op's rejection for the NEXT waiter
    // (the caller still sees the real rejection via `next`).
    this.chains.set(id, next.then(() => undefined, () => undefined))
    return next
  }

  // `async` so the synchronous validate/clone below reject (not throw) per the
  // Promise<void> contract — callers use `await expect(...).rejects`.
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    // Validate serializability BEFORE cloning, so a bad event surfaces the typed
    // "non-JSON-serializable" error rather than an opaque DataCloneError from
    // structuredClone below. (In an async method this throw becomes a rejection,
    // honoring the Promise<void> contract rather than throwing synchronously.)
    assertSerializable(events)
    // Deep-snapshot the batch here, BEFORE the op waits behind the per-session
    // chain: the op may await before serializing, so a caller that passes a live
    // array (e.g. session.events) and mutates it — OR mutates an event object
    // inside it — before the op runs would otherwise have those changes
    // persisted, or advance the cursor past what was actually written.
    // structuredClone covers both the array and the event objects (safe now that
    // serializability is checked above). The clone happens synchronously (before
    // the first await), so it is taken at call time.
    const batch = events.map(e => structuredClone(e))
    return this.serialize(id, () => this.appendCore(id, batch))
  }

  private async appendCore(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return
    assertSerializable(events)
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id) // calls loadCore, not load

    // Contiguity contract: each event's seq must continue the stored log.
    for (const [i, event] of events.entries()) {
      if (event.seq !== state.cursor + i) {
        throw new Error(`append seq mismatch for "${id}": expected ${state.cursor + i} at index ${i}, got ${event.seq}`)
      }
    }

    if (!state.materialized) {
      await this.materialize(state, events)
    } else {
      await this.appendLines(state, events)
    }
    // The durable event log is the transaction: advance the cursor as soon as
    // the log write commits. The sidecar (mutable summary) is best-effort here
    // — a failed sidecar write must NOT reject an append whose log already
    // landed (that would desync the cursor and let a retry duplicate seqs).
    state.cursor += events.length
    await this.touchSummary(state).catch(() => { /* sidecar is recoverable metadata; log is durable */ })
  }

  load(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    return this.serialize(id, () => this.loadCore(id))
  }

  private async loadCore(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    const cwd = this.states.get(id)?.meta.cwd
    const file = await this.findLog(id, cwd)
    if (file === undefined) throw new Error(`session "${id}" not found`)
    const buffer = await readFile(file.path)
    const { meta, events, committedBytes } = scanLog(buffer)
    this.assertVersion(meta)

    const summary = await this.readSidecar(id, meta.cwd)
    const fullMeta: SessionMeta = { ...meta, ...summary }

    // Crash-recovery: if the log ended mid-turn (an open turn with real,
    // preserved events but no closing turn/end), close it durably DURING load so
    // disk, the returned log, and the cursor all agree — both append routes then
    // continue with no special-casing. Synthesize the boundary events (a
    // step/end if a step was open, then a turn/end {kind:'interrupted'}); the
    // interrupted turn's real events are preserved, never truncated (a turn can
    // be huge — the session-persistence RFC).
    const closers = interruptedTurnClosers(events)
    const balanced = [...events, ...closers]

    // Set state BEFORE the repair writes so they can resolve the log path.
    const needsTorn = committedBytes < buffer.byteLength
    const state: SessionState = {
      meta: { ...fullMeta },
      cursor: events.length,
      materialized: true,
    }
    this.states.set(id, state)

    if (needsTorn) {
      // Discard the torn trailing fragment (a final line never fully flushed)
      // before writing the closers, so the closers land at a clean EOF.
      await this.repair(state, committedBytes)
    }
    if (closers.length > 0) {
      // Durably append the synthetic closers, then advance the cursor to the
      // balanced length. After this, disk == balanced and the next append (live
      // or direct) continues cleanly. No sidecar touch here: load is not a
      // summary-changing op (the closers carry no new title/firstPrompt), and
      // the next real append bumps `updatedAt` — keeping the summary write off
      // the recovery path avoids a second best-effort failure mode.
      await this.appendLines(state, closers)
      state.cursor = balanced.length
    }

    return { meta: fullMeta, events: balanced }
  }

  async list(): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = []
    for (const dir of await this.listCwdDirs()) {
      for (const name of await this.listJsonl(dir)) {
        // Read ONLY the header line, not the whole log: a session picker must
        // scale with the number of sessions, not the total size of every
        // conversation (the log persists every assistant/chunk verbatim, so a
        // full scanLog here would be O(total history)).
        const first = await this.readFirstLine(`${dir}/${name}`)
        if (first === undefined) continue // empty/half-written file
        const meta = parseHeaderMeta(first)
        if (meta === undefined) continue // not a session header
        const summary = await this.readSidecar(meta.id, meta.cwd)
        metas.push({ ...meta, ...summary })
      }
    }
    return metas
  }

  /**
   * Read the first newline-terminated line of a file without loading the whole
   * file. Returns undefined if the file is empty or has no complete first line
   * (a half-written log). Reads in bounded chunks so a huge log costs only the
   * header read.
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

  async has(id: SessionId): Promise<boolean> {
    const state = this.states.get(id)
    if (state?.materialized) return true
    const cwd = state?.meta.cwd
    return (await this.findLog(id, cwd)) !== undefined
  }

  delete(id: SessionId): Promise<void> {
    return this.serialize(id, () => this.deleteCore(id))
  }

  private async deleteCore(id: SessionId): Promise<void> {
    const cwd = this.states.get(id)?.meta.cwd
    const file = await this.findLog(id, cwd)
    if (file) await rm(file.path, { force: true })
    // Remove the sidecar too. A lazy session (update() before the first
    // append()) has a `.summary.json` sidecar but NO `.jsonl` log, and after a
    // restart the in-memory cwd is gone — so keying sidecar removal off the log
    // or the in-memory cwd would leak its possibly-sensitive title/firstPrompt.
    // Scan every cwd bucket for the sidecar by its (sanitized) filename.
    await this.removeSidecars(id)
    this.states.delete(id)
  }

  /** Remove a session's summary sidecar from EVERY cwd bucket (id is unique). */
  private async removeSidecars(id: SessionId): Promise<void> {
    const target = `${encodeSegment(id)}.summary.json`
    for (const dir of await this.listCwdDirs()) {
      await rm(`${dir}/${target}`, { force: true })
    }
  }

  update(id: SessionId, summary: Partial<SessionSummary>): Promise<void> {
    return this.serialize(id, () => this.updateCore(id, summary))
  }

  private async updateCore(id: SessionId, summary: Partial<SessionSummary>): Promise<void> {
    let state = this.states.get(id)
    if (state === undefined) state = await this.adopt(id)
    // Build the NEXT meta separately and commit it to in-memory state only AFTER
    // the sidecar write succeeds. update's only durable effect is the sidecar,
    // so a failure DOES reject (unlike append, whose log is the transaction and
    // sidecar is best-effort) — but if we mutated state.meta first, a later
    // touchSummary() on a successful append would persist the rejected
    // title/firstPrompt, making a failed update durable after the fact.
    const nextMeta: SessionMeta = { ...state.meta, ...summary }
    await this.writeSidecar(nextMeta)
    state.meta = nextMeta
  }

  // --- materialization / append / repair ---

  /** Atomically write the header line + first batch (temp-write, fsync, rename). */
  private async materialize(state: SessionState, events: readonly SessionEvent[]): Promise<void> {
    const dir = sessionDir(this.root, state.meta.cwd)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const finalPath = logPath(this.root, state.meta.cwd, state.meta.id)
    // Never rename over an existing committed log: materialize is the FIRST
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly rather than
    // clobber committed data. (createCore already guards the create path before
    // this point, so this is unreachable-in-practice defense-in-depth against a
    // TOCTOU/fork race; ignored for coverage.)
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${state.meta.id}": a log already exists on disk (load/resume it instead)`)
    }
    const header = JSON.stringify(toHeaderLine(state.meta))
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
    // concurrently cannot clobber each other (both could pass the exists() check
    // above, but only one link() wins). rename() would silently overwrite the
    // log the other process just committed.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // If link FAILED (EEXIST on a race, or any I/O error), the temp is the
      // only reference and must be removed before the original error propagates.
      // If link SUCCEEDED, the temp cleanup is deferred to AFTER the publish is
      // durable (below) so a temp-rm failure can never reject a session whose
      // log already published — that would leave state.materialized false and
      // wedge every retry on the exists() backstop above.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: on POSIX filesystems the new link is not
    // crash-durable until the parent directory's metadata is synced. The seam
    // contract is "append returns once durable", and materialize is the first
    // append's write — so the directory entry must be durable before we return.
    await this.syncDir(dir)
    state.materialized = true
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the (now-redundant) temp hard link must NOT reject the
    // append. A leftover `*.tmp` is harmless — it is never read, and the next
    // materialize of this id is guarded by exists()/link(). Swallow only the
    // rm failure; nothing else of consequence runs in the try.
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
   * Append event lines at EOF and fsync. On a write/sync failure AFTER the
   * kernel accepted some bytes (ENOSPC, an fsync error), truncate the file back
   * to its pre-append size before rethrowing: `cursor` is unchanged, so the
   * batch will be retried, and without this rollback the retry would append
   * AFTER the partial bytes — producing duplicate seqs that make `scanLog` see a
   * gap and render the session unloadable.
   */
  private async appendLines(state: SessionState, events: readonly SessionEvent[]): Promise<void> {
    const path = logPath(this.root, state.meta.cwd, state.meta.id)
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
  private async repair(state: SessionState, offset: number): Promise<void> {
    const path = logPath(this.root, state.meta.cwd, state.meta.id)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- sidecar (mutable summary) ---

  private async touchSummary(state: SessionState): Promise<void> {
    state.meta = { ...state.meta, updatedAt: Date.now() }
    await this.writeSidecar(state.meta)
  }

  /**
   * Atomic sidecar write (temp-write + rename), summary fields only.
   *
   * Deliberately NOT directory-fsynced (unlike {@link materialize}): the
   * sidecar holds mutable, recoverable summary metadata (updatedAt, title,
   * firstPrompt), not source-of-truth log data. The rename is atomic so a
   * reader never sees a torn file, but a power loss may lose the most recent
   * summary — acceptable because it is re-derivable and the durable log (the
   * transaction) is independently synced. Strict crash-durability is reserved
   * for the event log.
   */
  private async writeSidecar(meta: SessionMeta): Promise<void> {
    const dir = sessionDir(this.root, meta.cwd)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = sidecarPath(this.root, meta.cwd, meta.id)
    const summary: SessionSummary = {
      updatedAt: meta.updatedAt,
      ...meta.title !== undefined ? { title: meta.title } : {},
      ...meta.firstPrompt !== undefined ? { firstPrompt: meta.firstPrompt } : {},
    }
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    // Exclusive owner-only create ('wx', 0o600), matching the log-materialization
    // temp write: the sidecar can carry user data (title/firstPrompt), so a
    // predictable/pre-existing temp path must never be silently truncated and
    // followed (symlink race / disclosure). The random suffix already makes a
    // collision unlikely; 'wx' makes reuse an error rather than a clobber.
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(summary))
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  }

  /**
   * Read the mutable-summary sidecar, or `undefined` if it is absent/unreadable
   * (a session that has never been `update()`d, or a failed sidecar write). The
   * caller keeps the header-derived `updatedAt` (the session's createdAt) in
   * that case rather than overlaying `0` — reporting an active session as
   * updated at the Unix epoch would be wrong.
   */
  private async readSidecar(id: SessionId, cwd: string | undefined): Promise<SessionSummary | undefined> {
    try {
      const raw = await readFile(sidecarPath(this.root, cwd, id), 'utf8')
      return JSON.parse(raw) as SessionSummary
    } catch {
      return undefined
    }
  }

  // --- discovery helpers ---

  /** Find a session's log file across cwd buckets (when cwd is unknown). */
  private async findLog(id: SessionId, cwd: string | undefined): Promise<{ path: string; cwd: string | undefined } | undefined> {
    if (cwd !== undefined) {
      const path = logPath(this.root, cwd, id)
      return (await this.exists(path)) ? { path, cwd } : undefined
    }
    // Unknown cwd: scan buckets for a matching file name.
    const target = encodeSegment(id) + '.jsonl'
    for (const dir of await this.listCwdDirs()) {
      const path = `${dir}/${target}`
      if (await this.exists(path)) {
        // Recover cwd from the header for accurate sidecar pathing.
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
      // ENOENT = the root has not been created yet → genuinely no sessions.
      // Any other error (EACCES, ENOTDIR, transient I/O) must NOT be reported
      // as "no sessions" — a durable backend cannot silently pretend persisted
      // state is absent on a storage fault.
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
      // collapsed to `false` — otherwise load() reports "not found" and
      // collision checks proceed under a false absence assumption.
      if (isENOENT(error)) return false
      throw error
    }
  }

  /** Build a state for a session discovered on disk but not yet in memory. */
  private async adopt(id: SessionId): Promise<SessionState> {
    // loadCore (NOT load) — adopt runs inside an already-serialized op, so
    // re-entering the chain via the public load() would deadlock.
    await this.loadCore(id)
    const state = this.states.get(id)
    /* v8 ignore next -- loadCore always sets the state for the id */
    if (!state) throw new Error(`failed to adopt session "${id}"`)
    return state
  }

  private assertVersion(meta: SessionMeta): void {
    if (meta.version !== 1) {
      throw new Error(`unsupported session format version ${meta.version} for "${meta.id}" (only v1 is supported)`)
    }
  }

  // --- write path (session/event → flush drain) ---

  private installWritePath(): void {
    const ctx = this.ctx

    // Capture the header on creation; persist a fork's seed once. Record the
    // init promise so flush/dispose can await it (onCreated is async).
    ctx.on('session/created', (session) => { void this.initFor(session) })

    // Snapshot + buffer every event (the live object is mutable; clone so a
    // later in-place mutation of session.events cannot rewrite a buffered
    // event). Serializability is guaranteed at the source — `Session.append`
    // rejects non-JSON-serializable data before the event ever enters the log
    // or this emit — so structuredClone here can never hit a non-cloneable
    // value, and the durable log can never diverge from session.events.
    ctx.on('session/event', (session, event) => {
      let buffer = this.buffers.get(session)
      if (!buffer) this.buffers.set(session, buffer = [])
      buffer.push(structuredClone(event))
    })

    // Drain to the backend at the durability checkpoint.
    ctx.on('session/flush', session => this.flush(session))

    // Dispose must reach quiescence: await every session's init + final drain
    // BEFORE returning, so no write lands after teardown (orphan rename/ENOENT).
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.inits.values()])
      await Promise.allSettled([...this.buffers.keys()].map(s => this.flush(s)))
      await Promise.allSettled([...this.chains.values()])
    }, 'session-persistence-jsonl write path')

    // HMR: a hot reload does not replay session/created, so seed existing live
    // sessions (mirrors dsh-invariants).
    for (const session of ctx.sessions.list()) void this.initFor(session)
  }

  /** Start (once) the async init for a session and remember its promise. */
  private initFor(session: Session): Promise<void> {
    const existing = this.inits.get(session)
    if (existing) return existing
    // Snapshot the seed SYNCHRONOUSLY here — initFor runs inside the
    // `session/created` emit, before any later `append` adds non-seed events.
    // A clone freezes it against later mutation of the live event objects.
    const seed = session.events.map(e => structuredClone(e))
    const p = this.onCreated(session, seed)
    // Attach a no-op rejection handler so a failing init (e.g. an id collision)
    // does not surface as an unhandled rejection if no flush observes `p` before
    // it rejects. The REAL error is still delivered: flush/dispose await the
    // same `p` from the map and see the rejection there.
    p.catch(() => { /* observed by flush/dispose via the stored promise */ })
    this.inits.set(session, p)
    return p
  }

  /**
   * Whether a live `session`'s `seed` reproduces the first `cursor` persisted
   * events. Reads the on-disk committed prefix and compares. A `cursor` of 0
   * (nothing persisted yet) trivially matches. Used when a live session claims
   * ownerless state left by a prior `load()`/`create()` — to reject a fresh,
   * unrelated session that reuses the id and would otherwise have its seq
   * 0..cursor-1 events filtered as already-written.
   */
  private async seedMatchesPersisted(session: Session, seed: readonly SessionEvent[], cursor: number): Promise<boolean> {
    if (cursor === 0) return true
    const onDisk = await this.findLog(session.header.id, session.header.cwd)
    /* v8 ignore next -- a cursor > 0 means the log was materialized, so it exists */
    if (onDisk === undefined) return false
    const { events: diskEvents } = scanLog(await readFile(onDisk.path))
    return seedCoversPrefix(seed, diskEvents.slice(0, cursor))
  }

  /**
   * On session/created: sync the backend's in-memory state to a live Session.
   *
   * Cases, by whether this backend tracks the id and whether a log is on disk:
   *   1. Already in `states` (created here, or a prior load/resume) → no-op.
   *   2. Not tracked, a log EXISTS on disk, and it is a seq-aligned PREFIX of the
   *      live session's current events → ADOPT it (HMR/reload): a fresh backend
   *      instance (empty `states`) meets a live session whose log a previous
   *      instance materialized; the live object already carries that history (it
   *      is the source of truth this run), so we continue from the stored length
   *      instead of re-creating. This keeps persistence alive across hot reload.
   *   3. Not tracked, a log EXISTS on disk, but it is NOT a prefix of the live
   *      session's events → REJECT: a different session collides on the id. The
   *      SessionId is the identity, so two unrelated sessions sharing one is a
   *      bug, not a resume — fail loudly rather than clobber committed data.
   *   4. Not tracked and NO log on disk → a genuinely new session: register its
   *      meta (lazy) and persist its `seed` once.
   *
   * The public `create(meta)` API is stricter still (rejects ANY on-disk id):
   * there the caller asserts "brand new", so even a prefix match is a bug.
   *
   * The seed events were copied into the Session by its constructor WITHOUT
   * emitting session/event, so the write-behind buffer never sees them — the
   * one explicit `append(seed)` below is the only persistence of the seed.
   * Events appended AFTER creation flow through the session/event buffer and
   * are persisted by flush (filtered by the write cursor), never here.
   */
  private async onCreated(session: Session, seed: readonly SessionEvent[]): Promise<void> {
    const id = session.header.id
    const tracked = this.states.get(id)
    if (tracked !== undefined) {
      // case 1: already tracked.
      // (owner === session is a defensive same-object guard: initFor dedupes by
      // session object, so onCreated never actually runs twice for one session.)
      /* v8 ignore next -- initFor dedupes per session object; same-object re-entry can't occur */
      if (tracked.owner === session) return
      if (tracked.owner === undefined) {
        // Ownerless state was created via the public create()/load() API. The
        // FIRST live session to arrive claims it — but ONLY if its seed is the
        // already-persisted prefix. A load() for preview leaves cursor at the
        // persisted length; a fresh, unrelated session reusing that id has a
        // seed shorter than (or not matching) that prefix, so flush would filter
        // its seq 0..cursor-1 events as already-written and silently graft the
        // new conversation onto the old log. Verify the seed covers the cursor.
        if (!await this.seedMatchesPersisted(session, seed, tracked.cursor)) {
          throw new Error(`session "${id}" is already persisted with ${tracked.cursor} event(s) that do not match this live session (id collision)`)
        }
        tracked.owner = session
        // Persist the live seed SUFFIX beyond the persisted prefix. Constructor
        // seed events (from sessions.create(id, { seed })) never emit
        // session/event, so the write-behind buffer never sees them — without
        // this they would be lost and a later flush would seq-mismatch. (cursor
        // is 0 for a public create(), so this covers the whole seed there.)
        const suffix = seed.slice(tracked.cursor)
        if (suffix.length > 0) await this.append(id, suffix)
        return
      }
      // The state is owned by a DIFFERENT live session. We may reclaim the id
      // ONLY if that owner left nothing behind: never materialized a log (cursor
      // 0, not materialized) AND has no write-behind buffer still pending. A
      // session that appended events but was disposed before its first flush is
      // NOT materialized yet but DOES have buffered events — reclaiming then
      // would let that stale buffer drain against the new session's state
      // (persisting old events under the new id, or dropping the new session's
      // seq-0 events). Such an owner, and any materialized owner, is a real
      // collision and rejects; only a truly-abandoned (artifact-free) id is
      // freed, honoring lazy materialization's "leaves nothing behind" promise.
      const ownerBuffer = this.buffers.get(tracked.owner)
      if (!tracked.materialized && !ownerBuffer?.length) {
        this.states.delete(id)
      } else {
        throw new Error(`session "${id}" is already bound to a different live session in this backend (id collision)`)
      }
    }

    const onDisk = await this.findLog(id, session.header.cwd)
    if (onDisk !== undefined) {
      // Read the committed on-disk events and check they are a seq-aligned
      // prefix of the live session (HMR re-seeing its own session) vs. an
      // unrelated session colliding on the id.
      const { events: diskEvents } = scanLog(await readFile(onDisk.path))
      if (!seedCoversPrefix(seed, diskEvents)) {
        // case 3: genuine collision — fail loudly rather than clobber.
        throw new Error(`session "${id}" already has a persisted log on disk that does not match this live session (id collision)`)
      }
      // case 2: adopt. loadCore sets the state (cursor = committed length,
      // repair offset if a crash tail exists).
      await this.serialize(id, () => this.loadCore(id))
      const adopted = this.states.get(id)
      /* v8 ignore next -- loadCore always sets the state for the id */
      if (adopted !== undefined) adopted.owner = session
      // Persist the live SUFFIX beyond the on-disk prefix. These events live
      // ONLY in `seed` (the live session was ahead of disk — mid-turn at
      // reload, or events appended while the previous backend was disposed);
      // this backend never buffered them via session/event, so without this
      // they would be lost and the next flush (starting at a later seq) would
      // mismatch or skip them.
      const suffix = seed.slice(diskEvents.length)
      if (suffix.length > 0) await this.append(id, suffix)
      return
    }

    // case 4: a genuinely new session. Register its meta (lazy), then persist
    // its seed (events present at creation time) once.
    const meta: SessionMeta = { ...session.header, updatedAt: Date.now() }
    await this.create(meta)
    // Bind this state to the live session so a later DIFFERENT session reusing
    // the id is detected as a collision (case 1) rather than silently no-opped.
    const created = this.states.get(id)
    /* v8 ignore next -- create() always sets the state for the id */
    if (created !== undefined) created.owner = session
    if (seed.length > 0) {
      await this.append(id, seed)
    }
  }

  private async flush(session: Session): Promise<void> {
    // Wait for the session's init (onCreated) to finish so the state/cursor and
    // any fork-seed persistence are in place before we drain. Awaiting the same
    // promise initFor stored also surfaces an init failure (e.g. an id
    // collision) here, where the caller of session/flush observes it.
    await this.inits.get(session)
    // Serialize the WHOLE drain (read cursor → append → splice) on the
    // per-session chain. Two concurrent flushes (e.g. an idle inject()'s
    // fire-and-forget flush racing an explicit checkpoint) would otherwise both
    // read the same cursor, both compute the same `fresh` slice, and the second
    // append would seq-mismatch against the cursor the first already advanced.
    await this.serialize(session.header.id, () => this.drain(session))
  }

  /** Drain a session's write buffer to disk. Caller serializes this per id. */
  private async drain(session: Session): Promise<void> {
    const buffer = this.buffers.get(session)
    if (!buffer?.length) return
    // Copy WITHOUT removing: the buffer is the only durable-pending copy of
    // these events (session/event does not re-emit). Splicing before the append
    // means a failed append (disk error, or a seq mismatch after a dropped bad
    // event) permanently loses a completed turn. Drain the buffer only AFTER
    // the append commits; events pushed during the await sit past batch.length
    // and survive the prefix splice, so a retry/dispose re-drains the rest.
    const batch = buffer.slice()
    const state = this.states.get(session.header.id)
    // Only append events at or beyond the write cursor (a resumed session's
    // seed is already on disk; the cursor was set to the loaded length). flush
    // awaits the init above, which always sets state, so the `?? 0` fallback is
    // a defensive guard that never fires in practice.
    /* v8 ignore next -- state is always set by the awaited init before flush */
    const cursor = state?.cursor ?? 0
    const fresh = batch.filter(e => e.seq >= cursor)
    // appendCore (NOT the serialized append) — drain already runs inside the
    // per-session chain, so re-entering it via append() would deadlock.
    if (fresh.length > 0) await this.appendCore(session.header.id, fresh)
    buffer.splice(0, batch.length)
  }
}

export default SessionPersistenceJsonl
