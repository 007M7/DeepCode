/**
 * File-backed credentials provider layering the live process environment over
 * a `$DSH_HOME/.env` document. The environment is authoritative and read-only
 * (a launch-time override must win, and must be visibly read-only rather than
 * silently shadow writes); the file is the provider-managed writable source:
 * every write re-reads the document under a cross-process writer lock before
 * rewriting only its own line — preserving every other byte, physical line
 * endings and quoted multi-line values included — external edits hot-publish
 * through the seam, and each reload replaces the snapshot wholesale so a
 * deleted entry never lingers in memory.
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'dotenv'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'
import { Credentials, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Credentials document path; defaults to `.env` under the harness home. */
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
 * otherwise the document lives at `<harness home>/.env`.
 * @param config - raw plugin config.
 * @returns the resolved file location and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), '.env')),
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Values that survive a dotenv round-trip without quoting. */
const BARE_VALUE = /^[A-Za-z0-9_@%+:,./-]+$/

/** Whether a value contains C0 control characters (newlines included) no dotenv style reads back. */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) < 0x20) return true
  }
  return false
}

/**
 * Render one `KEY=value` line in the narrowest style dotenv reads back
 * verbatim: bare, then single quotes (fully literal), then double quotes
 * (safe only without backslashes, which double-quote reading expands).
 * A value no style can represent fails loud instead of corrupting silently.
 */
function renderLine(ref: CredentialRef, value: string): string {
  if (BARE_VALUE.test(value)) return `${ref}=${value}`
  if (hasControlCharacters(value)) {
    throw new Error(`credentials-local: the value for "${ref}" contains control characters the .env line format cannot represent`)
  }
  if (!value.includes('\'')) return `${ref}='${value}'`
  if (!value.includes('"') && !value.includes('\\')) return `${ref}="${value}"`
  throw new Error(`credentials-local: the value for "${ref}" mixes quoting no .env style can represent; edit the file directly`)
}

/** Split text into physical lines with their terminators attached. */
function physicalLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/)
}

/** One physical line's content without its terminator. */
function lineContent(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n')) return line.slice(0, -1)
  return line
}

/** One physical line's terminator (empty on a final unterminated line). */
function lineTerminator(line: string): string {
  return line.slice(lineContent(line).length)
}

/** An assignment line: optional export, a POSIX identifier, `=`, the value part. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** Quote characters dotenv reads across physical lines. */
const MULTILINE_QUOTES = ['\'', '"', '`']

/**
 * The quote character an assignment's value part opens without closing on its
 * own line — the following physical lines are that value's continuation, not
 * assignments — or `undefined` for a single-line value.
 */
function opensMultiline(valuePart: string): string | undefined {
  const trimmed = valuePart.trimStart()
  const quote = trimmed[0]
  if (quote === undefined || !MULTILINE_QUOTES.includes(quote)) return undefined
  const rest = trimmed.slice(1)
  const body = quote === '"' ? rest.replaceAll('\\"', '') : rest
  return body.includes(quote) ? undefined : quote
}

/** Whether a continuation line closes the given quote. */
function closesQuote(content: string, quote: string): boolean {
  const body = quote === '"' ? content.replaceAll('\\"', '') : content
  return body.includes(quote)
}

/**
 * Replace, insert, or delete one reference's assignment while preserving
 * every other byte: untouched lines keep their exact content and terminators
 * (CRLF included), and the physical lines inside another key's quoted
 * multi-line value are never mistaken for assignments. The first matching
 * assignment is rewritten in place with its own line ending; later duplicates
 * drop (dotenv reads the last one, so a surviving duplicate would override
 * the edit); an insert appends in the document's dominant ending style.
 */
function upsertLine(text: string | undefined, ref: CredentialRef, rendered: string | undefined): string {
  const lines = physicalLines(text ?? '')
  const dominant = lines.some(line => line.endsWith('\r\n')) ? '\r\n' : '\n'
  const out: string[] = []
  let placed = false
  let pendingQuote: string | undefined
  for (const line of lines) {
    const content = lineContent(line)
    if (pendingQuote !== undefined) {
      // Inside a quoted multi-line value: never an assignment, always kept.
      if (closesQuote(content, pendingQuote)) pendingQuote = undefined
      out.push(line)
      continue
    }
    const match = ASSIGNMENT.exec(content)
    if (match === null) {
      out.push(line)
      continue
    }
    const [, key, valuePart] = match
    if (key !== ref) {
      /* v8 ignore next -- the value group is `(.*)`, which always participates; the fallback only satisfies noUncheckedIndexedAccess */
      pendingQuote = opensMultiline(valuePart ?? '')
      out.push(line)
      continue
    }
    // The write path refuses multi-line targets before rendering, so the
    // matched assignment is single-line and drops or rewrites wholesale.
    if (rendered !== undefined && !placed) {
      out.push(`${rendered}${lineTerminator(line) === '' ? dominant : lineTerminator(line)}`)
      placed = true
    }
  }
  if (rendered !== undefined && !placed) {
    const last = out[out.length - 1]
    if (last !== undefined && lineTerminator(last) === '') {
      out[out.length - 1] = `${last}${dominant}`
    }
    out.push(`${rendered}${dominant}`)
  }
  return out.join('')
}

/** File-backed credentials provider (`$DSH_HOME/.env`). */
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
    if (stored !== undefined && stored.length > 0) return Promise.resolve({ value: stored, source: 'file' })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const env = process.env[ref]
    if (env !== undefined && env.length > 0) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    const stored = this.values.get(ref)
    if (stored !== undefined && stored.length > 0) {
      // A quoted multi-line value resolves fine but the line editor refuses to
      // rewrite it, so writability must say what set() would actually do.
      return Promise.resolve({ configured: true, source: 'file', writable: !stored.includes('\n') })
    }
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
        if (existing !== undefined && existing.includes('\n')) {
          throw new Error(
            `credentials-local: "${ref}" is a multi-line entry this line editor would corrupt; edit ${this.spec.filename} directly`,
          )
        }
        const nextText = upsertLine(this.text, ref, value === undefined ? undefined : renderLine(ref, value))
        // 0600: a document holding secrets is never world-readable.
        await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        if (value === undefined) this.values.delete(ref)
        else this.values.set(ref, value)
        // After the commit: a broken observer must never make the durable
        // write look failed (an INVARIANT failure still rethrows).
        this.notifyUpdated(ref)
      }, {
        onStaleBreak: (lockPath) => {
          this.ctx.logger.warn('credentials-local: breaking a stale writer lock at %s', lockPath)
        },
      })
    })
  }

  /** Reject a write the live environment would shadow into apparent no-effect. */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    const env = process.env[ref]
    if (env !== undefined && env.length > 0) {
      throw new Error(
        `credentials-local: "${ref}" is supplied read-only by the process environment, so ${verb} would be`
        + ' shadowed; change the launching environment instead',
      )
    }
  }

  /** Boot read: an absent file is an empty store; any other failure is loud. */
  private async loadInitial(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return
    }
    this.text = text
    this.values = new Map(Object.entries(parse(text)))
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
   * into the seam. Absence publishes the empty store; an unreadable file
   * throws, so each caller picks its policy — a reload warns and keeps the
   * last good snapshot, a write fails loud. dotenv parsing is lenient by
   * design and cannot fail.
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
    const next = text === undefined ? new Map<string, string>() : new Map(Object.entries(parse(text)))
    const changed = this.changedRefs(this.values, next)
    this.text = text
    this.values = next
    for (const ref of changed) this.notifyUpdated(ref)
  }
  /* jscpd:ignore-end */

  /** Seam-addressable entries whose effective (non-empty) value changed. */
  private changedRefs(prev: Map<string, string>, next: Map<string, string>): CredentialRef[] {
    const changed: CredentialRef[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      const before = prev.get(key)
      const after = next.get(key)
      const effectiveBefore = before !== undefined && before.length > 0 ? before : undefined
      const effectiveAfter = after !== undefined && after.length > 0 ? after : undefined
      if (effectiveBefore === effectiveAfter) continue
      try {
        changed.push(credentialRef(key))
      } catch (_unaddressableKey) {
        // A key that is not a POSIX identifier is preserved file content the
        // seam cannot address, so no observer could ever see it change.
      }
    }
    return changed
  }
}

export default CredentialsLocal
