/**
 * File-backed live-session registry: one lock-guarded JSON file under the
 * Harness home implements the `@deepseek-ai/dsh-session-registry` seam. Every
 * operation is a read-modify-write under an advisory lock, because concurrent
 * launchers write the same file — the storage-hub JSON backend documents
 * last-write-wins for exactly this case and cannot be reused. Liveness is
 * derived at read time from the recorded pid.
 * @module @deepseek-ai/dsh-session-registry-file
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from 'cordis'
import lockfile from 'proper-lockfile'
import z from 'schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionRegistry, BootId,
  type SessionRegistration, type SessionRegistryRecord,
} from '@deepseek-ai/dsh-session-registry'
import { EMPTY_REGISTRY, parseRegistry, serializeRegistry } from './file.ts'
import { isPidAlive } from './liveness.ts'

export { SESSION_REGISTRY_FORMAT_VERSION, parseRegistry, serializeRegistry } from './file.ts'
export type { RegistryFileContents } from './file.ts'
export { isPidAlive } from './liveness.ts'

/** The file name holding the registry, relative to {@link Config.root}. */
export const REGISTRY_FILE_NAME = 'sessions.json'

/** Default lock staleness threshold; a held lock older than this is reclaimed. */
const DEFAULT_LOCK_STALE_MS = 10_000

/** Default retry budget for a contended lock acquisition. */
const DEFAULT_LOCK_RETRIES = 10

/**
 * Plugin config as callers write it: `root` is required — a cwd fallback would
 * scatter registries — while the lock tunables are optional because
 * `static Config` supplies their defaults.
 */
export interface Config {
  /** Directory holding the registry file; created `0o700` on demand. */
  root: string
  /** Milliseconds after which a held lock is considered abandoned and reclaimed. */
  lockStaleMs?: number
  /** Retries before a contended acquisition fails loud. */
  lockRetries?: number
}

/** The file-backed {@link SessionRegistry} implementation. */
export class SessionRegistryFile extends SessionRegistry {
  static Config: z<Config> = z.object({
    root: z.string().required(),
    lockStaleMs: z.natural().default(DEFAULT_LOCK_STALE_MS),
    lockRetries: z.natural().default(DEFAULT_LOCK_RETRIES),
  })

  /** Absolute path of the registry file this service reads and writes. */
  readonly file: string

  /** Directory holding {@link file}, created `0o700` on demand. */
  private readonly root: string

  /** Tail of the in-process serialization chain; see {@link mutate}. */
  private chain: Promise<void> = Promise.resolve()

  /** Resolved lock staleness threshold in milliseconds, fixed at construction. */
  private readonly stale: number

  /** Resolved contended-acquisition retry budget, fixed at construction. */
  private readonly retries: number

  constructor(ctx: Context, config: Config) {
    super(ctx, BootId(randomUUID()))
    this.root = config.root
    this.file = join(this.root, REGISTRY_FILE_NAME)
    // Resolve the optional tunables here, once: `static Config` supplies these
    // same defaults for a Loader mount, and a direct programmatic mount that
    // omits them gets them too rather than an undefined lock option.
    this.stale = config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.retries = config.lockRetries ?? DEFAULT_LOCK_RETRIES
  }

  /** @inheritdoc */
  async register(registration: SessionRegistration): Promise<() => Promise<void>> {
    const record: SessionRegistryRecord = {
      sessionId: registration.sessionId,
      pid: process.pid,
      cwd: registration.cwd,
      startedAt: Date.now(),
      bootId: this.bootId,
      ...registration.title !== undefined && { title: registration.title },
    }
    await this.mutate(records => [
      ...records.filter(other => other.sessionId !== record.sessionId),
      record,
    ])
    // The disposer is awaited by Cordis teardown, so the record is durably gone
    // before disposal completes rather than racing process exit. A failure here
    // is reported, not thrown: the record is already pid-prunable, and an
    // unwinding teardown must not be turned into a rejection.
    return this.ctx.effect(() => async () => {
      try {
        await this.mutate(records => records.filter(other => !this.isSelf(other, record)))
      } catch (error) {
        this.ctx.logger.warn('failed to deregister %s: %s', record.sessionId, String(error))
      }
    })
  }

  /** @inheritdoc */
  async retitle(sessionId: SessionId, title: string): Promise<void> {
    await this.mutate(records => records.map(record =>
      record.sessionId === sessionId && record.pid === process.pid && record.bootId === this.bootId
        ? { ...record, title }
        : record))
  }

  /** @inheritdoc */
  async list(): Promise<SessionRegistryRecord[]> {
    // Pruning is a write, so the read path takes the same lock: a listing that
    // observed a half-written file could omit a live session.
    return this.mutate(records => [...records])
  }

  /** True when a stored record is this exact registration (pid AND incarnation). */
  private isSelf(candidate: SessionRegistryRecord, self: SessionRegistryRecord): boolean {
    return candidate.sessionId === self.sessionId
      && candidate.pid === self.pid
      && candidate.bootId === self.bootId
  }

  /**
   * Serialize one read-modify-write cycle against every other cycle in THIS
   * process, then run it under the cross-process lock.
   *
   * Both layers are required and neither substitutes for the other. The advisory
   * lock excludes other processes but is tracked per process, so it rejects a
   * same-process concurrent acquisition outright (`ELOCKED`) instead of queueing
   * — and a composition that creates several sessions at once really does
   * overlap these calls. This chain gives those callers a queue; the lock gives
   * independent processes exclusion.
   */
  private mutate(
    change: (records: readonly SessionRegistryRecord[]) => SessionRegistryRecord[],
  ): Promise<SessionRegistryRecord[]> {
    // Failures must not poison the chain for later callers, so the tail only
    // tracks settlement, never the rejection itself.
    const result = this.chain.then(() => this.mutateExclusively(change))
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Run one locked read-modify-write cycle: read, prune dead records, apply
   * `change`, and republish when the result differs from what was stored.
   */
  private async mutateExclusively(
    change: (records: readonly SessionRegistryRecord[]) => SessionRegistryRecord[],
  ): Promise<SessionRegistryRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    // proper-lockfile needs the target to exist before it can guard it; an
    // exclusive create loses harmlessly to a concurrent launcher doing the same.
    await this.ensureFile()
    const release = await lockfile.lock(this.file, {
      stale: this.stale,
      retries: { retries: this.retries, minTimeout: 20, maxTimeout: 500 },
    })
    try {
      const before = await this.read()
      const live = before.records.filter(record => isPidAlive(record.pid))
      const next = change(live)
      // Republish when a record changed or the medium itself was damaged, so a
      // foreign or torn file heals instead of being re-parsed on every read.
      if (!before.intact || !sameRecords(before.records, next)) await this.write(next)
      return next
    } finally {
      await release()
    }
  }

  /** Create the registry file if absent, without disturbing existing content. */
  private async ensureFile(): Promise<void> {
    try {
      const handle = await open(this.file, 'wx', 0o600)
      try {
        await handle.writeFile(serializeRegistry(EMPTY_REGISTRY.records))
      } finally {
        await handle.close()
      }
    } catch (error) {
      // Swallows only EEXIST: another launcher created the file first, which is
      // the intended outcome. Every other errno propagates.
      /* v8 ignore next -- a non-EEXIST create failure needs a permission or IO fault on a root this cycle just created 0o700. */
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Read and parse the registry file; a missing file reads as empty. */
  private async read(): Promise<{ records: SessionRegistryRecord[]; intact: boolean }> {
    // The caller holds the lock, and acquiring it requires the file to exist, so
    // a read failure here is real corruption rather than an absent registry and
    // propagates: a swallowed error would report "no live sessions" for a medium
    // that could not be read.
    return parseRegistry(await readFile(this.file, 'utf8'))
  }

  /** Publish the complete record set via temp-write plus atomic rename. */
  private async write(records: readonly SessionRegistryRecord[]): Promise<void> {
    const temp = join(dirname(this.file), `.${REGISTRY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temp, serializeRegistry(records), { mode: 0o600 })
    await rename(temp, this.file)
  }
}

/** Compare record lists by identity fields, to decide whether a write is needed. */
function sameRecords(left: readonly SessionRegistryRecord[], right: readonly SessionRegistryRecord[]): boolean {
  if (left.length !== right.length) return false
  return left.every((record, index) => {
    const other = right[index]
    return other !== undefined
      && record.sessionId === other.sessionId
      && record.pid === other.pid
      && record.bootId === other.bootId
      && record.cwd === other.cwd
      && record.startedAt === other.startedAt
      && record.title === other.title
  })
}

export default SessionRegistryFile
