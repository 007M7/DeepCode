/**
 * Shared Workspace picker plugin, browser half. WorkspacePicker registers in
 * the sidebar and page-local Session Intent hero slots, reads real Host Workspaces
 * through the global useWorkspaces hook, and delegates selection semantics to
 * each owner. Its injected share creates a Workspace without creating a
 * Session. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePickerInjected } from './contract/slots.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'

export type { WorkspacePickerInjected, WorkspacePickerProps } from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * the ui-sidebar apply, whose activation order relative to this one is NOT
 * constrained: dshClient.inject edges are informational (loading/prefetch
 * metadata, never apply sequencing) and the sidebar provides no waitable
 * service. apply therefore registers via declaration-aware deferral instead
 * of assuming order.
 */
export const inject = ['slots', 'workspaces']

/**
 * Register WorkspacePicker in both owner slots once their declarations are on
 * the ledger. The inject factory returns a plain Workspace creation callback;
 * data reads use the framework's global useWorkspaces hook.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
  })
  // Declaration-aware registration: the sidebar's declaring apply may
  // activate after this one (entry activation order is unconstrained), and a
  // register into an undeclared slot throws. Register once the declaration
  // is on the ledger; the subscription also re-registers after an HMR
  // collapse re-declares the slot (the cascade disposed our entry with it).
  ctx.effect(() => {
    const slotNames = ['sidebar.workspace', 'conversation.empty.workspace'] as const
    const disposers = new Map<(typeof slotNames)[number], () => void>()
    const tryRegister = (name: (typeof slotNames)[number]): void => {
      if (ctx.slots.spec(name) === undefined) return
      if (ctx.slots.entries(name).some(e => e.component === WorkspacePicker)) return
      disposers.set(name, ctx.slots.register({ name, inject: injected }, WorkspacePicker))
    }
    const unsubscribers = slotNames.map(name => ctx.slots.subscribe(name, () => { tryRegister(name) }))
    for (const name of slotNames) tryRegister(name)
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const dispose of disposers.values()) dispose()
    }
  }, 'ui-workspace: picker registrations')
}
