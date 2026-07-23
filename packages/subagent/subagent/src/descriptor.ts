/**
 * The durable continuable-child descriptor: the versioned, model-hidden
 * `subagent/descriptor` session event that records a child's declared
 * composition so a known child id can be cold-resumed after its run — and its
 * process — are gone. Providers append it turn-enclosed in the child's initial
 * turn; the control service folds it back on resume.
 *
 * The descriptor deliberately snapshots explicit fields rather than the
 * merge-extensible `AgentOptions` object: an unrelated extension value cannot
 * make continuation fail merely because it is not JSON, and later composition
 * inputs require a deliberate {@link SUBAGENT_DESCRIPTOR_VERSION} change. It
 * omits `subagentDepth` — cold resume trusts the persisted header's
 * `delegationDepth` as the monotone floor — and `outputSchema`, which belongs
 * to one activation's result contract rather than durable child composition.
 *
 * @module @deepseek-ai/dsh-subagent/descriptor
 */

import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Durable declared composition of a continuable subagent child, appended
     * once by the establishing provider inside the child's initial turn,
     * before its first request. Log-only: it carries no `surfaceOp`, never
     * enters model history, and the append-only log retains it when
     * compaction replaces surface history.
     */
    'subagent/descriptor': SubagentDescriptorData
  }
}

/**
 * The current descriptor format version, stamped into every appended
 * `subagent/descriptor` event and required verbatim by {@link foldSubagentDescriptor}.
 * Supporting another composition input is a deliberate version change, never
 * an implicit extra field.
 */
export const SUBAGENT_DESCRIPTOR_VERSION = 1

/** The `subagent/descriptor` event payload — a continuable child's declared composition. */
export interface SubagentDescriptorData {
  /** Descriptor format version ({@link SUBAGENT_DESCRIPTOR_VERSION}). */
  readonly version: number
  /** The `ctx.subagents` provider name that established the child. */
  readonly provider: string
  /** Resolved child `agentOptions.provider`, when one was declared. */
  readonly agentProvider?: string
  /** Resolved child `agentOptions.model`, when one was declared. */
  readonly agentModel?: string
  /** Per-child persona that shadows the deployment persona on resume. */
  readonly persona?: string
  /** Child tool scoping reapplied on resume. */
  readonly toolFilter?: ToolRestriction
}

/** Inputs {@link snapshotSubagentDescriptor} validates and detaches. */
export interface SubagentDescriptorInput {
  /** The `ctx.subagents` provider name that will establish the child. */
  readonly provider: string
  /** Requested child `agentOptions.provider`. */
  readonly agentProvider?: string
  /** Requested child `agentOptions.model`. */
  readonly agentModel?: string
  /** Requested per-child persona. */
  readonly persona?: string
  /** Requested child tool scoping. */
  readonly toolFilter?: ToolRestriction
}

/**
 * Validate and detach descriptor inputs into the durable payload, before any
 * Task or provider work begins — the same detached lossless-JSON boundary the
 * session log itself enforces, applied early so a synchronous validation
 * failure rejects the tool call without creating a Task.
 * @param input - the caller-collected composition fields.
 * @returns the versioned, detached descriptor payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotSubagentDescriptor(input: SubagentDescriptorInput): SubagentDescriptorData {
  const candidate: SubagentDescriptorData = {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    provider: input.provider,
    ...input.agentProvider !== undefined ? { agentProvider: input.agentProvider } : {},
    ...input.agentModel !== undefined ? { agentModel: input.agentModel } : {},
    ...input.persona !== undefined ? { persona: input.persona } : {},
    ...input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {},
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('subagent descriptor is not losslessly JSON-serializable')
  }
  return snapshot
}

/**
 * Fold a persisted child log to its supported descriptor. The first
 * `subagent/descriptor` event is authoritative — the establishing provider
 * appends exactly one, so a later same-type event cannot rewrite the declared
 * composition.
 * @param events - the loaded child session events.
 * @returns the descriptor, or `undefined` when the log has none or its
 *   version is not {@link SUBAGENT_DESCRIPTOR_VERSION} (the child is not
 *   resumable by this runtime).
 */
export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/descriptor'> => candidate.type === 'subagent/descriptor',
  )
  if (event === undefined) return undefined
  if (event.data.version !== SUBAGENT_DESCRIPTOR_VERSION) return undefined
  return event.data
}
