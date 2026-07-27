/**
 * commands domain contract: the web catalog/dispatch face of the host command
 * registry (`ctx.commands`). Both methods address one session's agent via
 * `sessionId` — every served session has an Agent (Session+Agent are born
 * together), so there is no agent-less surface on this wire.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Handler-free command view served to clients. Wire mirror of the host
 * registry descriptor (which stays host-side with its cordis dependencies);
 * no source field — the host descriptor has none.
 */
export interface CommandDescriptor {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: { readonly hint: string }
}

/** Detached command outcome rendered directly by the requesting client. */
export interface CommandExecuteResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** Command-domain unary methods (the map keys command.* of RpcMethodMap). */
export interface CommandsApi {
  /**
   * Lists the addressed agent's effective command catalog (name-sorted,
   * globals plus its scoped shadows).
   */
  list(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ commands: readonly CommandDescriptor[] }>>

  /**
   * Parses and executes one slash-command line against the addressed agent
   * without sending it to the model. matched=false when syntax or name does
   * not resolve (the client falls back to its default sink). The signal rides
   * beside the request, never on the wire: the fetch carrier's request signal
   * cancels the running handler.
   */
  execute(request: RpcRequest<{ sessionId: SessionId; line: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ matched: boolean; result?: CommandExecuteResult }>>
}
