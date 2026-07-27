/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from './contract/slots.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'

export type {
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dshClient.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore registers via
 * declaration-aware deferral instead of assuming order.
 */
export const inject = ['slots', 'sessions', 'workspaces']

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; unscoped New Session rides
    // the runtime's shared action (recent-Workspace projection inside).
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    open: (sessionId) => { ctx.sessions.open(sessionId) },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: input => ctx.workspaces.create(input),
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
  })
  // Declaration-aware registration: each owner's declaring apply may activate
  // after this one (entry activation order is unconstrained), and a register
  // into an undeclared slot throws. Register once the declaration is on the
  // ledger; the subscription also re-registers after an HMR collapse
  // re-declares the slot (the cascade disposed our entry with it).
  ctx.effect(() => {
    const registrations = [
      {
        name: 'sidebar.workspaces' as const,
        component: WorkspaceBrowser,
        register: () => ctx.slots.register(
          { name: 'sidebar.workspaces', store: createWorkspaceViewStore(), inject: browserInjected },
          WorkspaceBrowser,
        ),
      },
      {
        name: 'conversation.hero.workspace' as const,
        component: WorkspacePicker,
        register: () => ctx.slots.register(
          { name: 'conversation.hero.workspace', inject: pickerInjected },
          WorkspacePicker,
        ),
      },
    ]
    const disposers = new Map<string, () => void>()
    const tryRegister = (entry: (typeof registrations)[number]): void => {
      if (ctx.slots.spec(entry.name) === undefined) return
      if (ctx.slots.entries(entry.name).some(e => e.component === entry.component)) return
      disposers.set(entry.name, entry.register())
    }
    const unsubscribers = registrations.map(entry =>
      ctx.slots.subscribe(entry.name, () => { tryRegister(entry) }))
    for (const entry of registrations) tryRegister(entry)
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const dispose of disposers.values()) dispose()
    }
  }, 'ui-workspace: browser + picker registrations')
}
