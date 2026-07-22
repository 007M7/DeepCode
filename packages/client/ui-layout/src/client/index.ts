/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action seam; navigation state lives
 * with the runtime sessions service.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutService } from './service.ts'

// Contract surface only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// LayoutService: the ctx.layout service class (consumers type against it).
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutService } from './service.ts'

declare module 'cordis' {
  interface Context {
    layout: LayoutService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session slots carry no
    // owner share: the framework injects sessionId as a standard prop.
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    'conversation': { kind: 'single'; scope: 'session'; owner: ConvOwnerProps }
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    'conversation.empty': { kind: 'single'; scope: 'root'; owner: EmptyOwnerProps }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Session owner shares stay literally empty: a phantom
// `sessionId?: never` would intersect with the framework's mandatory
// SessionStandardProps.sessionId and collapse the composed props to never —
// the anti-smuggling guard is mutually exclusive with standard injection, so
// the standard member's own type is the only guard on standard keys. Phantom
// members remain fine on keys the standards never claim (EmptyOwnerProps).

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the concession chain rendered the column at zero width. */
  collapsed: boolean
  /** Rendered column width in px (0 when collapsed). */
  width: number
}

/** Conversation owner share: empty — sessionId arrives as a framework-standard prop. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Empty-state owner share (ui-conversation registers EmptyState here). */
export interface EmptyOwnerProps { children?: never }

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutService()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session' },
        'details': { kind: 'single', scope: 'session' },
        'conversation.empty': { kind: 'single', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // No business face for the frame (I = {}): the hook's job is the
      // assembly side effect wiring the entry's bound actions into the
      // cross-plugin service seam.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')
}
