/**
 * Workspace entity registry (`ctx.workspace`): durable workspace records over
 * the domain data form, with session attachment validated against stored
 * session headers. This package owns the `WorkspaceId` brand and the
 * `workspace` domain; consumers see the {@link Workspace} interface only.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context, Service } from 'cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: merges `sessionPersistence` into the Context service map for the
// optional `ctx.get` lookups below.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceRecord } from './spec.ts'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'
import { realpathNormalize } from './paths.ts'
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type { Workspace } from './types.ts'
export { workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - the raw workspace id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

declare module 'cordis' {
  interface Context {
    workspace: WorkspaceRegistry
  }
}

/**
 * The workspace registry service. Opens the `workspace` domain at startup,
 * rebuilds one entity per stored record, and serves entities from an
 * in-memory cache keyed by id. Session persistence is an OPTIONAL peer
 * (resolved via `ctx.get`, never injected): while it is absent, session
 * attachment rejects (what cannot be validated is not recorded) and
 * `sessionIds` projections serve the account unfiltered.
 *
 * There is deliberately no delete entry point in this phase: workspace
 * deletion ships as one complete semantic together with the session-cascade
 * primitives (future work in the owning Agent Note).
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storage']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  /**
   * Session ids known to exist in session persistence; `undefined` until the
   * first successful listing. Refreshed at startup and on every attach
   * validation — within one process sessions are only ever added (this phase
   * has no delete primitive), so the set can only lag by missing very recent
   * sessions, never by holding dead ones from this process's lifetime.
   */
  private known?: Set<string>

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    knownSessionIds: () => this.known,
    readSessionHeader: id => this.readSessionHeader(id),
  }

  constructor(ctx: Context) {
    super(ctx, 'workspace')
  }

  /** Open the domain and rebuild the entity cache before the service is published as active. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storage.domain.open(workspaceDomainSpec)
    // This registry owns the domain handle it opened: closing on fiber
    // disposal frees the domain name, so a re-plugged registry can reopen it.
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      this.known = new Set<string>((await persistence.list()).map(header => header.id))
    }
    // Rebuild entities, rejecting states the write side makes structurally
    // impossible (an external medium edit is the only way in, and hiding it
    // would silently pick a winner): one session accounted under two
    // workspaces, or two records claiming one canonical path (plain string
    // equality — stored paths are already canonical, so no realpath here).
    const accounted = new Map<string, WorkspaceId>()
    const paths = new Map<string, WorkspaceId>()
    for (const [id, record] of this.table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  /**
   * Create a workspace over an existing directory. The path is canonicalized
   * through `fs.realpath` first — a nonexistent path rejects with the
   * original `ENOENT`, a path resolving to anything but a directory rejects,
   * and a canonical path already owned by another workspace (including a
   * symlink resolving to it) rejects.
   * @param path - Directory the workspace points at; canonicalized before storing.
   * @param title - Display title; defaults to `basename` of the canonical path.
   * @returns the created workspace after durability.
   */
  async create(path: string, title?: string): Promise<Workspace> {
    const table = this.requireTable()
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) {
        throw new Error(`a workspace for '${canonical}' already exists ('${entity.id}')`)
      }
    }
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: title ?? basename(canonical),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    // Cache before the durable put: a concurrent same-path create fails the
    // scan above, and the entity already exists when `domain/changed` fires.
    this.entities.set(id, entity)
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    return entity
  }

  /**
   * Look up a workspace by id.
   * @param id - The workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Snapshot of all workspaces, in load-then-creation order.
   * @returns a fresh array of the cached entities.
   */
  list(): Workspace[] {
    return [...this.entities.values()]
  }

  /**
   * Resolve a workspace by directory path, through the same `fs.realpath`
   * canon as {@link create} (hence async). A path that does not exist rejects
   * with the original error — a missing directory has no canonical form to
   * compare (a workspace whose recorded directory vanished is only reachable
   * by id; see `Workspace.status`).
   * @param path - Directory path in any spelling (symlinks, `..`, trailing slash).
   * @returns the owning workspace, or `undefined` when none matches.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) {
      throw new Error('workspace registry is not started yet')
    }
    return this.table
  }

  /**
   * Read one stored session header for attach validation, refreshing the
   * known-session view from the same listing. Rejects when session
   * persistence is absent or holds no session with this id.
   */
  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error(
        `cannot validate session '${id}': no session persistence service is available`,
      )
    }
    const headers = await persistence.list()
    this.known = new Set<string>(headers.map(header => header.id))
    const header = headers.find(candidate => candidate.id === id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }
}

export default WorkspaceRegistry
