/**
 * Registry record vocabulary: the durable shape one live `dsh` process
 * publishes about itself and `dsh list-sessions` reads back.
 * @module @deepseek-ai/dsh-session-registry/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Identifies one process incarnation. Minted per registering process, so a
 * record whose `pid` was recycled by the operating system cannot be mistaken
 * for the original: the boot id differs even when the pid matches.
 */
export type BootId = Branded<'BootId'>

/**
 * Brand a string as a {@link BootId}.
 * @param id - the raw boot id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function BootId(id: string): BootId {
  return id as BootId
}

/**
 * One live session's self-published registration. Every field is immutable for
 * the lifetime of the registration: a process publishes once at startup and
 * removes the record on exit, never mutating it in place.
 *
 * Only top-level surfaces a user starts directly register: in-process subagents
 * have no process of their own, and out-of-process subagent backends spawn
 * `dsh-jsonrpc-agent` rather than this CLI, so neither can reach the registry.
 */
export interface SessionRegistryRecord {
  /** The session this process is running. Unique across live records. */
  readonly sessionId: SessionId
  /** Operating-system process id, used with `bootId` to decide liveness. */
  readonly pid: number
  /** Absolute workspace directory the session acts on. */
  readonly cwd: string
  /** Non-negative safe-integer Unix epoch milliseconds when the process registered. */
  readonly startedAt: number
  /** This process incarnation's id, distinguishing a recycled `pid`. */
  readonly bootId: BootId
  /**
   * Human-readable session title, as the registering process last knew it.
   *
   * Carried in the record rather than read from the session log: the log's
   * location, file format, and compression are per-deployment backend choices,
   * so an independent reader cannot portably parse one. Absent until a title
   * exists — a fresh session has none.
   */
  readonly title?: string
}
