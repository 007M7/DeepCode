/**
 * skills domain contract: read-only skill catalog lookup addressed by session.
 * The session's header cwd resolves to the canonical project root host-side —
 * the client never submits a raw path, and skill lookup never creates or
 * resumes an Agent.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Skill catalog row (wire projection of the host SkillSummary; provider/source vocabulary stays host-side). */
export interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** False marks a user-only skill (`disable-model-invocation`): invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}

/** Skill-domain unary methods (the map keys skill.* of RpcMethodMap). */
export interface SkillsApi {
  /** Lists the user-invocable skill catalog for the session's project. */
  list(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ skills: readonly SkillEntry[] }>>

  /**
   * Injects one user-invocable skill into the addressed agent as a user-role
   * message (the canonical `<skill_content>` rendering, with `text` appended
   * when present) and starts a turn. The host enforces user-invocation policy
   * here — on the discovery summary and again on the loaded definition, so a
   * catalog change between the two lookups cannot slip a user-disabled body
   * through — a model-only or unknown name is refused regardless of what a
   * client menu offered. The carrier's request signal aborts the skill
   * lookup and refuses injection once the caller has given up (`cancelled`).
   * Session-backed subagents reject with `agent-busy`.
   */
  invoke(request: RpcRequest<{ sessionId: SessionId; name: string; text?: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ accepted: true }>>
}
