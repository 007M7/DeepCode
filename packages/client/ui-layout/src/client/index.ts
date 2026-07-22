/**
 * Layout plugin, browser half: three-column AppFrame plus ctx.layout, the
 * shell-level viewing-state authority (navigation + panel geometry).
 * Contract: api-contracts v3 section 5. apply provides the service and
 * defines the three top-level slots; frame components are exported for the
 * web shell's assembly (the shell resolves this surface from the loader
 * module table and closes the slots over its own scopedSlots).
 */
import type { Context } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LayoutService } from './service.ts'

export { AppFrame, CenterColumn, DetailsColumn, type AppFrameProps } from './AppFrame.tsx'
export {
  clampWidth, computeColumns,
  CENTER_MIN, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  type Columns, type PanelInput,
} from './columns.ts'
export { LayoutService, type NavState, type PanelState, type ViewId } from './service.ts'

declare module 'cordis' {
  interface Context {
    layout: LayoutService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    // children deliberately absent on every entry: the B-a validation layer
    // gates COMPONENT delegation, and no P-I slot component delegates —
    // conversation.empty is rendered by the shell's assembly closure, not
    // handed down by ConversationRoot (its slots face is ScopedSlots<never>).
    'conversation': { kind: 'single'; scope: 'session'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    'conversation.empty': { kind: 'single'; scope: 'root'; owner: EmptyOwnerProps }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// as OwnerOf<K> & StandardOf<K> & OwnInjected (reference, never re-typed).

/** Sidebar owner share: the owner supplies nothing — everything arrives via inject. */
export interface SidebarOwnerProps { slots?: never }

/** Conversation owner share. */
export interface ConvOwnerProps { sessionId: SessionId }

/** Details owner share. */
export interface DetailsOwnerProps { sessionId: SessionId }

/** Empty-state owner share (ui-conversation registers EmptyState here). */
export interface EmptyOwnerProps { slots?: never }

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots']

/**
 * Client plugin body: provide ctx.layout and define the three top-level slots.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const layout = new LayoutService(ctx)
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeSidebar = ctx.slots.define('sidebar', { kind: 'single', scope: 'root' })
    const disposeConversation = ctx.slots.define('conversation', { kind: 'single', scope: 'session' })
    const disposeDetails = ctx.slots.define('details', { kind: 'single', scope: 'session' })
    const disposeEmpty = ctx.slots.define('conversation.empty', { kind: 'single', scope: 'root' })
    return () => {
      disposeEmpty()
      disposeDetails()
      disposeConversation()
      disposeSidebar()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
      layout.dispose()
    }
  }, 'ui-layout: service + slot definitions')
}
