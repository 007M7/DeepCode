/**
 * File-backed credentials provider layering the live process environment over
 * a `$DSH_HOME/.credentials.yaml` document. The environment is authoritative
 * and read-only (a launch-time override must win, and must be visibly
 * read-only rather than silently shadow writes); the file is the
 * provider-managed writable source: every write re-reads the document under a
 * cross-process writer lock before patching only its own key — comments and
 * the formatting of every untouched entry survive — external edits
 * hot-publish through the seam, and each reload replaces the snapshot
 * wholesale so a deleted entry never lingers in memory.
 *
 * The document holds nothing but credentials, which is why it is a strict
 * `CredentialRef`-to-string mapping rather than a dotenv file: a store the
 * Harness owns and never materializes into the environment cannot also serve
 * as the user's environment layer, and conflating the two is what made a
 * non-secret in the old `$DSH_HOME/.env` silently unreachable.
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { Credentials, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Basename of the credentials document inside the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Credentials document path; defaults to `.credentials.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  filename: string
  watch: boolean
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the document lives at `<harness home>/.credentials.yaml`.
 * @param config - raw plugin config.
 * @returns the resolved file location and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME)),
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Parse one credentials document into its entries. The document is a strict
 * mapping of {@link CredentialRef} to non-empty string: a non-mapping root, a
 * key that is not a POSIX identifier, a non-string value, and an empty string
 * are all rejected rather than skipped, because this file holds nothing but
 * credentials and a silently ignored entry reads as "the key I stored has no
 * effect". Duplicate keys surface as parser errors. An empty document is an
 * empty store.
 * @param text - the document's text.
 * @param filename - absolute path, quoted in errors.
 * @returns the parsed entries, keyed by reference.
 */
export function parseCredentialsDocument(text: string, filename: string): Map<string, string> {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`credentials-local: invalid document at ${filename}: ${
      document.errors.map(error => error.message).join('; ')}`)
  }
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`credentials-local: ${filename} must be a mapping of credential reference to value`)
  }
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    // credentialRef throws on anything that is not a POSIX identifier, which
    // is exactly the constraint a stored reference must satisfy to be
    // addressable through the seam.
    credentialRef(key)
    if (typeof value !== 'string') {
      throw new TypeError(`credentials-local: the value for "${key}" in ${filename} must be a string`)
    }
    if (value.length === 0) {
      throw new Error(`credentials-local: the value for "${key}" in ${filename} is empty; remove the key instead`)
    }
    entries.set(key, value)
  }
  return entries
}

/**
 * Render the next document text with one reference set or deleted. Editing
 * the parsed document rather than rebuilding it keeps comments and the
 * formatting of every untouched entry; an absent document starts a fresh one.
 * @param text - the current document text, `undefined` while the file is absent.
 * @param ref - the reference to write.
 * @param value - the new value, or `undefined` to delete the key.
 * @returns the text to persist.
 */
function renderDocument(text: string | undefined, ref: CredentialRef, value: string | undefined): string {
  // `text` only ever caches content that parsed successfully, so this re-parse
  // for the mutable comment-preserving tree cannot fail.
  const document = text === undefined ? new Document({}) : parseDocument(text)
  if (value === undefined) document.deleteIn([ref])
  else document.setIn([ref], value)
  return document.toString()
}

/** File-backed credentials provider (`$DSH_HOME/.credentials.yaml`). */
export class CredentialsLocal extends Credentials {
  /* jscpd:ignore-start -- deliberate config-surface and lifecycle symmetry with
     settings-local (prefer symmetry for parallel values); extracting the shared
     shape would couple the two providers' teardown semantics across packages. */
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last read or persisted document; `undefined` while the
   * file is absent. Watcher events whose content equals this cache are no-ops,
   * which is also the self-write suppression.
   */
  private text: string | undefined
  /** Parsed document snapshot; replaced wholesale on every reload. */
  private values = new Map<string, string>()
  /**
   * Single exclusive operation chain: watcher reloads and line edits run one
   * at a time in queue order (settled tail), so an edit can never render from
   * text a concurrent reload is busy replacing.
   */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new writes and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }
  /* jscpd:ignore-end */

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Drain: refuse new operations, then settle the queued ones so disposal
      // completes only once storage is quiescent.
      this.closed = true
      await this.operations
    }
    await this.loadInitial()
    if (!this.spec.watch) return
    /* jscpd:ignore-start -- same watcher discipline as settings-local by design:
       the serialized-refresh and quiesce-on-dispose shape is the reviewed
       lifecycle contract, not accidental repetition. */
    const watcher = chokidarWatch(this.spec.filename, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    watcher.on('all', () => {
      if (this.closed) return
      this.queueRefresh()
    })
    watcher.on('ready', () => {
      // The initial load raced the watcher's own setup: a change written
      // between that read and the watcher becoming active never fires an
      // event. One reconcile at ready closes the gap.
      if (this.closed) return
      this.queueRefresh()
    })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('credentials-local: watcher error on %s', this.spec.filename)
      this.ctx.logger.warn(error)
    })
    yield async () => {
      // Quiesce: stop accepting events, close the watcher, then wait out any
      // queued or in-flight operation so nothing publishes after disposal.
      this.closed = true
      await watcher.close()
      await this.operations
    }
    /* jscpd:ignore-end */
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const env = process.env[ref]
    if (env !== undefined && env.length > 0) return Promise.resolve({ value: env, source: 'env' })
    const stored = this.values.get(ref)
    if (stored !== undefined) return Promise.resolve({ value: stored, source: 'file' })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const env = process.env[ref]
    if (env !== undefined && env.length > 0) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    const stored = this.values.get(ref)
    if (stored !== undefined) return Promise.resolve({ configured: true, source: 'file', writable: true })
    return Promise.resolve({ configured: false, writable: true })
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.write(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.write(ref, undefined)
  }

  /* jscpd:ignore-start -- the operation-chain and reload lifecycle is the same
     reviewed contract as settings-local, deliberately mirrored (prefer symmetry
     for parallel values); the two providers own different documents and
     failure policies, so extracting the shape would couple their teardown
     semantics across packages for a handful of lines. */
  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; only an invariant violation escaping the fan-out can reject it. */
  private queueRefresh(): void {
    void this.enqueue(() => this.refresh()).catch((error: unknown) => {
      // Only an invariant violation escaping the update fan-out can reject a
      // refresh; keep the operation queue alive and surface it as an error so
      // one poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.error('credentials-local: reload commit failed at %s', this.spec.filename)
      this.ctx.logger.error(error)
    })
  }
  /* jscpd:ignore-end */

  /** Queue one line edit; entry checks reject early, the queue re-judges them at run time. */
  private async write(ref: CredentialRef, value: string | undefined): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    if (this.isClosed()) {
      throw new Error(`credentials-local is disposed: cannot ${verb} "${ref}"`)
    }
    this.assertUnshadowed(ref, verb)
    return this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${ref}" ${verb} ran`)
      }
      // Re-judged at run time: the environment may have changed while queued.
      this.assertUnshadowed(ref, verb)
      // The writer lock's exclusive create needs the parent to exist; 0700
      // because the harness home holds user-private data.
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        // Read-modify-write: fold in any on-disk state this process has not
        // observed yet — an external edit still inside the watcher debounce
        // window, a change the watcher missed, or another process's write —
        // so the line edit below can never resurrect a stale document.
        await this.reconcileFromDisk()
        const existing = this.values.get(ref)
        if (value === undefined && existing === undefined) return
        const nextText = renderDocument(this.text, ref, value)
        // 0600: a document holding secrets is never world-readable.
        await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        if (value === undefined) this.values.delete(ref)
        else this.values.set(ref, value)
        // After the commit: a broken observer must never make the durable
        // write look failed (an INVARIANT failure still rethrows).
        this.notifyUpdated(ref)
      })
    })
  }

  /** Reject a write the live environment would shadow into apparent no-effect. */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    const env = process.env[ref]
    if (env !== undefined && env.length > 0) {
      throw new Error(
        `credentials-local: "${ref}" is supplied read-only by the process environment, so ${verb} would be`
        + ' shadowed; unset it in the launching environment (or in a loaded .env) instead',
      )
    }
  }

  /**
   * Boot read: an absent file is an empty store; an invalid one fails the
   * plugin's activation, because a credentials document that exists but
   * cannot be trusted must never be treated as "no credentials stored".
   */
  private async loadInitial(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return
    }
    this.values = parseCredentialsDocument(text, this.spec.filename)
    this.text = text
  }

  /* jscpd:ignore-start -- same deliberate mirror of settings-local's reload and
     reconcile policy: warn-and-keep on a reload, throw on a write, invariant
     failures propagate. */
  /**
   * Re-read the document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable document keeps the
   * last good snapshot and warns — a live hot-reload must never take the
   * process down. An invariant violation escaping the fan-out is not a reload
   * failure and propagates to the queue's error surface.
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.ctx.logger.warn('credentials-local: reload failed at %s; keeping the last good document', this.spec.filename)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Compare the on-disk text against the cache and publish any difference
   * into the seam. Absence publishes the empty store; an unreadable or
   * invalid document throws, so each caller picks its policy — a reload warns
   * and keeps the last good snapshot, a write fails loud rather than
   * overwriting a document it could not understand.
   */
  private async reconcileFromDisk(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text || this.isClosed()) return
    const next = text === undefined ? new Map<string, string>() : parseCredentialsDocument(text, this.spec.filename)
    const changed = this.changedRefs(this.values, next)
    this.text = text
    this.values = next
    for (const ref of changed) this.notifyUpdated(ref)
  }
  /* jscpd:ignore-end */

  /** Entries whose stored value changed; the parser has already proven every key addressable. */
  private changedRefs(prev: Map<string, string>, next: Map<string, string>): CredentialRef[] {
    const changed: CredentialRef[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (prev.get(key) === next.get(key)) continue
      changed.push(credentialRef(key))
    }
    return changed
  }
}

export default CredentialsLocal
