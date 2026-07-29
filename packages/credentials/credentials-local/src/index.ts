/**
 * File-backed credentials provider layering the live process environment over
 * a `$DSH_HOME/.env` document. The environment is authoritative and read-only
 * (a launch-time override must win, and must be visibly read-only rather than
 * silently shadow writes); the file is the provider-managed writable source:
 * `set`/`unset` rewrite only their own line and preserve every other byte,
 * external edits hot-publish through the seam, and each reload replaces the
 * snapshot wholesale so a deleted entry never lingers in memory.
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'dotenv'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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

/** Match the physical line(s) assigning one reference (ref chars need no escaping). */
function refLinePattern(ref: CredentialRef): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${ref}\\s*=`)
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

/**
 * Replace, insert, or delete one reference's assignment while preserving every
 * other byte. The first matching line is rewritten in place; further matches
 * are dropped (dotenv reads the last one, so duplicates are dead weight that
 * would otherwise override the edit).
 */
function upsertLine(text: string | undefined, ref: CredentialRef, line: string | undefined): string {
  const lines = text === undefined || text.length === 0 ? [] : text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const matcher = refLinePattern(ref)
  const out: string[] = []
  let placed = false
  for (const current of lines) {
    if (matcher.test(current)) {
      if (line !== undefined && !placed) {
        out.push(line)
        placed = true
      }
      continue
    }
    out.push(current)
  }
  if (line !== undefined && !placed) out.push(line)
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/** File-backed credentials provider (`$DSH_HOME/.env`). */
export class CredentialsLocal extends Credentials {
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
  /** Serializes watcher-triggered reloads so reads never interleave. */
  private refreshTask: Promise<void> = Promise.resolve()
  /** Serializes writes to the one document; settled tail. */
  private writeChain: Promise<unknown> = Promise.resolve()
  /** Set at dispose: refuse new writes and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Drain: refuse new writes, then settle the queued ones so disposal
      // completes only once storage is quiescent.
      this.closed = true
      await this.writeChain
    }
    await this.loadInitial()
    if (!this.spec.watch) return
    const watcher = chokidarWatch(this.spec.filename, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    watcher.on('all', () => {
      if (this.closed) return
      this.refreshTask = this.refreshTask.then(() => this.refresh()).catch((error: unknown) => {
        // Only an invariant violation escaping the update fan-out can reject a
        // refresh; keep the reload queue alive and surface it as an error so
        // one poisoned commit cannot silently end hot reloading forever.
        this.ctx.logger.error('credentials-local: reload commit failed at %s', this.spec.filename)
        this.ctx.logger.error(error)
      })
    })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('credentials-local: watcher error on %s', this.spec.filename)
      this.ctx.logger.warn(error)
    })
    yield async () => {
      // Quiesce: stop accepting events, close the watcher, then wait out any
      // queued or in-flight refresh so nothing publishes after disposal.
      this.closed = true
      await watcher.close()
      await this.refreshTask
    }
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
      return Promise.resolve({ configured: true, source: 'file', writable: true })
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

  /** Queue one line edit; entry checks reject early, the queue re-judges them at run time. */
  private async write(ref: CredentialRef, value: string | undefined): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    if (this.isClosed()) {
      throw new Error(`credentials-local is disposed: cannot ${verb} "${ref}"`)
    }
    this.assertUnshadowed(ref, verb)
    // The stored tail is settled on both outcomes, so chaining needs no catch
    // and one rejected write can never poison the queue for later callers.
    const previous = this.writeChain
    const run = previous.then(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${ref}" ${verb} ran`)
      }
      // Re-judged at run time: the environment may have changed while queued.
      this.assertUnshadowed(ref, verb)
      const existing = this.values.get(ref)
      if (value === undefined && existing === undefined) return
      if (existing !== undefined && existing.includes('\n')) {
        throw new Error(
          `credentials-local: "${ref}" is a multi-line entry this line editor would corrupt; edit ${this.spec.filename} directly`,
        )
      }
      const nextText = upsertLine(this.text, ref, value === undefined ? undefined : renderLine(ref, value))
      // 0600: a document holding secrets is never world-readable.
      await writeFileAtomic(this.spec.filename, nextText, { mode: 0o600 })
      this.text = nextText
      if (value === undefined) this.values.delete(ref)
      else this.values.set(ref, value)
      this.ctx.emit('credentials/updated', ref)
    })
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
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

  /**
   * Re-read the document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable document keeps the
   * last good snapshot and warns — a live hot-reload must never take the
   * process down. dotenv parsing is lenient by design and cannot fail.
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    let text: string | undefined
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) {
        this.ctx.logger.warn('credentials-local: reload failed at %s; keeping the last good document', this.spec.filename)
        this.ctx.logger.warn(error)
        return
      }
      text = undefined
    }
    if (text === this.text || this.isClosed()) return
    const next = text === undefined ? new Map<string, string>() : new Map(Object.entries(parse(text)))
    const changed = this.changedRefs(this.values, next)
    this.text = text
    this.values = next
    for (const ref of changed) this.ctx.emit('credentials/updated', ref)
  }

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
