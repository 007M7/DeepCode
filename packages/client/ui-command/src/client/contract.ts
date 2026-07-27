/**
 * Frozen contract of the client command surface. Types only. The
 * CommandService (`ctx.command`) implements this face; business packages
 * consume `register` alone.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-slash/client'

/** One option row of a popupSelect shell. */
export interface SelectOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly active?: boolean
}

/**
 * Business registration for the popupSelect command kind. Data is
 * self-served: options/onSelect use the business package's own protocol.
 * The shell component is owned by ui-command; business never sees it. Both
 * callbacks receive the ClientSessionContext captured at popup open.
 */
export type CommandUiSpec = {
  readonly kind: 'popupSelect'
  options(session: ClientSessionContext, signal: AbortSignal): Promise<readonly SelectOption[]>
  onSelect(option: SelectOption, session: ClientSessionContext): void | Promise<void>
}

/**
 * One client-owned command contribution: a slash-menu entry whose behavior
 * lives entirely on the client (no host descriptor). Merged with the host
 * catalog by name — a collision with a host command fails loud at candidate
 * synthesis, never shadows.
 */
export interface CommandContribution {
  /** Command name without the leading slash (unique across contributions). */
  readonly name: string
  /** Menu row description. */
  readonly description: string
  /** Capability filter, called with a fresh projection per candidate pass. */
  available(session: ClientSessionContext): boolean
  /** The command's UI behavior (this phase: popupSelect only). */
  readonly ui: CommandUiSpec
}

/** The `ctx.command` service face visible to business packages. */
export interface CommandServiceContract {
  /**
   * Register one client command contribution; effect disposer. Duplicate
   * names throw at registration.
   */
  register(contribution: CommandContribution): () => void
  /** Resolve the per-session popup controller for one session scope (wiring/overlay layer). */
  popupFor(actx: ClientContext): unknown
}
