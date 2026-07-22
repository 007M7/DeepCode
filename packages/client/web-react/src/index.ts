/**
 * ctx-to-React machinery (slot terminal design §8): createSlotRenderer (the
 * install-seam implementation), SessionProvider (framework-wired render
 * prop), the defineStore shell, and useInvoke. Contract types (SlotRenderer
 * family, store family, four-share props) are ui-slots authority — this face
 * re-exports the ones its own values traffic in. The snapshot-store ENGINE
 * (createSnapshotStore) is framework-internal — runtime/i18n reach it through
 * the './store' subpath; business plugins declare stores via defineStore
 * only. React contexts stay in-package: business components see none.
 */
import type { SnapshotSelectorHook } from './store/index.ts'

// -- store: the declarative shell is public; the engine stays off this face --
export type {
  ActionsDecl, BakedActions, BoundActions, EngineStoreHandle, EngineStoreInstance,
  ObservableSnapshot, SnapshotSelectorHook, SnapshotStore,
  StoreFactory, StoreHandle, StoreInstance, StoreSpec,
} from './store/index.ts'
export { defineStore, shallowEqual } from './store/index.ts'
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
  HostObservable, RenderOpts, SessionCell,
  SlotRenderer, SlotRendererHost, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export { SlotOwnershipError, StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
export { createSlotRenderer } from './scoped-slots.tsx'

// -- session area: the framework-wired provider; binding contexts stay internal --
export { SessionProvider, SlotAssemblyError, type SessionProviderProps } from './session-provider.tsx'

export { useInvoke } from './use-invoke.ts'
