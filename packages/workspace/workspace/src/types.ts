/**
 * Public type vocabulary of the workspace entity: the `WorkspaceId` brand and
 * the `Workspace` consumer interface. Types only — the `WorkspaceId` factory
 * lives in `index.ts` (this file carries no runtime code).
 * @module @deepseek-ai/dsh-workspace/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/**
 * One workspace: a stable id over an existing directory, a display title, and
 * the ordered account of sessions that belong to it. The account is the sole
 * source of ownership — sessions are never inferred from cwd. Consumers only
 * see this interface; the entity implementation stays package-private.
 */
export interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /**
   * Sessions recorded under this workspace, in attach order (the array order
   * is the display order). A projection: accounted ids whose session no
   * longer exists in session persistence are filtered out here (and dropped
   * from the durable account on the next mutation); when session persistence
   * is absent the account is served unfiltered because membership cannot be
   * verified.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Record a session under this workspace. Idempotent: a session already on
   * the account resolves without writing (membership is decided on the
   * domain write chain, so unawaited concurrent attach/detach calls settle
   * in call order). For a session not yet on the account, its stored header
   * is read from session persistence and its `cwd`, normalized through the
   * same `fs.realpath` canon as workspace paths, must equal this workspace's
   * {@link path} — a missing persistence service, an unknown session id, a
   * header without `cwd`, a `cwd` that no longer resolves, or a mismatched
   * `cwd` all reject without touching the account (what cannot be validated
   * is not recorded).
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing (decided on the domain write chain,
   * like attach). Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
