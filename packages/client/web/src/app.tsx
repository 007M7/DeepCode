/**
 * Real-UI assembly closure. Runs only after loader.settled(): resolves the
 * layout plugin's export surface from the loader module table (type-only
 * import keeps the plugin out of the shell bundle), closes SessionProvider and
 * scopedSlots over the shell's whitelist, and mounts RootBindingProvider so
 * root-slot inject factories can reach ctx.
 */
import type { ReactNode } from 'react'
import type { Context } from 'cordis'
import {
  createSessionProvider, RootBindingProvider, scopedSlots,
} from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'

type LayoutExports = typeof import('@deepseek-ai/dsh-client-ui-layout/client')

/** Assembly inputs: the settled root ctx plus the loader's module-table read surface. */
export interface AssemblyDeps {
  /** Client root context (all plugin services provided). */
  ctx: Context
  /** Module-table resolver (the loader's require; missing spec = throw). */
  requireModule: (spec: string) => unknown
}

/**
 * Build the renderApp factory handed to AppRoot.
 * @param deps - assembly inputs.
 * @returns factory producing the real UI tree (called once per AppRoot render after settled).
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const layoutExports = deps.requireModule('@deepseek-ai/dsh-client-ui-layout/client') as LayoutExports
  const { AppFrame, CenterColumn, DetailsColumn } = layoutExports
  const layout = ctx.layout
  // ctx.get: the typed `sessions` Context merge is suspended pending the
  // client/host declaration-collision arbitration (runtime's merge note).
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions === undefined) throw new Error('shell assembly: sessions service unavailable')

  // Whitelist closure: the four layout-owned top slots, granted to the shell assembler.
  const slots = scopedSlots(ctx.slots.core, 'sidebar', 'conversation', 'details', 'conversation.empty')

  // Stable references — created once per assembly, never per render.
  const rootBinding = { ctx }
  const useCurrent = (): SessionId | undefined => layout.current.useSelector((s) => s.sessionId)
  const useSidebar = layout.sidebar.useSelector
  const useDetails = layout.details.useSelector
  const setSidebarWidth = (px: number): void => { layout.setSidebarWidth(px) }
  const setDetailsWidth = (px: number): void => { layout.setDetailsWidth(px) }

  const renderBody = (id: SessionId): ReactNode => (
    <>
      <CenterColumn>{slots.renderSlot('conversation', { sessionId: id })}</CenterColumn>
      <DetailsColumn>{slots.renderSlot('details', { sessionId: id })}</DetailsColumn>
    </>
  )
  // No selected session: the conversation.empty root slot carries EmptyState
  // (ui-conversation registers it); the fallback keeps the grid shape until
  // that owner lands.
  const renderEmpty = (): ReactNode => (
    <>
      <CenterColumn>{slots.renderSlot('conversation.empty', {}, { fallback: null })}</CenterColumn>
      <DetailsColumn />
    </>
  )

  // Provider deps speak plain string (web-react's inversion: it never imports
  // runtime); the assembler re-brands at this boundary — ids entering the
  // provider came from layout.current, which only holds validated SessionIds.
  const SessionProvider = createSessionProvider({
    useCurrent,
    resolveBinding: (id) => sessions.binding(id as SessionId),
    renderBody: (id) => renderBody(id as SessionId),
  })

  return () => (
    <RootBindingProvider value={rootBinding}>
      <AppFrame
        useSidebar={useSidebar}
        useDetails={useDetails}
        setSidebarWidth={setSidebarWidth}
        setDetailsWidth={setDetailsWidth}
        sidebar={slots.renderSlot('sidebar', {})}
      >
        <SessionProvider renderEmpty={renderEmpty} />
      </AppFrame>
    </RootBindingProvider>
  )
}
