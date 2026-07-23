/**
 * Tool-ring contract: the props surface handed to toolview components, the
 * registry's resolve/registration shapes, and the tool-call block union.
 * Shared face between the chat domain (ToolViewOutlet consumes resolve) and
 * the toolviews domain (registry implementation + sample rows); domain
 * implementation files import this, never each other.
 */
import type { FC } from 'react'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { CallId, Translate } from './views.ts'

// The block union's defining home is runtime (fold-product types); the
// contract only forwards it (type-definition authority stays with the layer
// that produces the values).
export type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'

/** Props handed to registered toolview components. */
export interface ToolViewProps {
  callId: CallId
  toolName: string
  block: ToolCallBlock
  useSession: UseSession
  actions: { openDetails(): void }
  t: Translate
}

/**
 * Toolview inject factory: produces the registrant's private injected share
 * `I`, called once per (registration x session) and cached by the render
 * outlet. Mirrors the slot inject shape (parameters derive from the
 * declaration): toolviews are session-domain by nature, so the factory
 * receives the session id only — service access goes through the
 * registrant's own apply-closure ctx (design §5; binding objects retired).
 */
export type ToolViewInject<I extends object> = (sessionId: SessionId) => I

/** Options accepted by the toolview registry's register; `I` is inferred from the inject factory. */
export interface ToolViewOptions<I extends object = object> {
  /** Session filter; absent = global registration. */
  scope?: (sessionId: SessionId) => boolean
  /** Private inject factory merged into the row's props by the render outlet. */
  inject?: ToolViewInject<I>
}

/**
 * A resolved toolview registration. `I` is erased to `object` on the resolve
 * read face (storage erases the per-registration parameter; the outlet merges
 * injected props untyped — the register site already proved component ⊇ I).
 */
export interface ResolvedToolView<I extends object = object> {
  component: FC<ToolViewProps & I>
  inject?: ToolViewInject<I>
}

/** The registry's read face consumed by render outlets (implementation lives in the toolviews domain). */
export interface ToolViewResolver {
  /**
   * Resolve the renderer for a tool in a session. Order: scope match (later
   * registration wins) > global > undefined (caller falls back to the
   * generic card).
   * @param tool - tool name.
   * @param sessionId - session the row renders in.
   * @returns resolved view, or undefined when nothing matches.
   */
  resolve(tool: string, sessionId: SessionId): ResolvedToolView | undefined
  /**
   * Subscribe to registration changes (synchronous).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
  /**
   * Monotonic version for uSES pairing.
   * @returns current version.
   */
  getVersion(): number
}
