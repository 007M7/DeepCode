/**
 * ctx-to-React glue: uSES bridge, SessionProvider (dependency-inverted),
 * scopedSlots outlet factory, useInvoke. Contract: api-contracts v3 section 2.
 */
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from './store/index.ts'

export type {
  ObservableSnapshot, SnapshotSelectorHook, SnapshotStore,
} from './store/index.ts'
export { createSnapshotStore, shallowEqual } from './store/index.ts'
export { bindSnapshotSelector } from './bind.ts'

/**
 * Selector hook over a session's conversation snapshot. Wide (`object`) by
 * default inside this dependency-inverted package; runtime narrows it once at
 * its export surface (`UseSession<ConversationSnapshot>`) — the snapshot type
 * never flows back into web-react.
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

/** Session assembly handle narrowed from ui-slots' structural form. */
export interface SessionBinding<Snap extends object = object> {
  readonly sessionId: string
  readonly session: { useSelector: UseSession<Snap> }
  readonly ctx: unknown
}

/** SessionProvider dependency surface (inverted: web-react never imports runtime). */
export interface SessionProviderDeps {
  useCurrent: () => string | undefined
  resolveBinding: (id: string) => SessionBinding | undefined
  /** Assembler-owned body: the shell closes over its own scopedSlots to render the session slots. */
  renderBody: (id: string) => ReactNode
}

export { createSessionProvider, RootBindingProvider, SlotAssemblyError, useRootBinding, useSessionBinding } from './session-provider.tsx'

export { scopedSlots } from './scoped-slots.tsx'

export { useInvoke } from './use-invoke.ts'
