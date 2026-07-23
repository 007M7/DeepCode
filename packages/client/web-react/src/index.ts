/**
 * Shell-side React glue (slot terminal design §8): createSlotRenderer (the
 * install-seam implementation), SessionProvider (framework-wired render
 * prop, also delivered as a standard seat to session-area entries),
 * bindSnapshotSelector (the one hook constructor), and useInvoke. The
 * snapshot-store engine and defineStore live in runtime (store relocation);
 * contract types are ui-slots authority — this face re-exports only what its
 * own values traffic in. React contexts stay in-package: business components
 * see none.
 */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export { bindSnapshotSelector } from './bind.ts'

/**
 * Selector hook over a session's conversation snapshot. Wide (`object`) by
 * default inside this dependency-inverted package; runtime narrows it once at
 * its export surface (`UseSession<ConversationSnapshot>`) — the snapshot type
 * never flows back into web-react.
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

// -- renderer: the install-seam implementation; contract lives in ui-slots --
export type {
  ChainRenderOpts, HostObservable, RenderOpts, SessionCell, SnapshotSelectorHook,
  SlotRenderer, SlotRendererHost, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export { SlotOwnershipError, StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
export { createSlotRenderer } from './scoped-slots.tsx'

// -- session area: the framework-wired provider; binding contexts stay internal --
export { SessionProvider, SlotAssemblyError, type SessionProviderProps } from './session-provider.tsx'

export { useInvoke } from './use-invoke.ts'
