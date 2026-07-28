/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * two directory-flow holes with a renderless occupant that answers each
 * `open` by driving `host.pickDirectory` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces']

/**
 * Client plugin body: register the renderless native flow into both
 * directory-flow holes (declaration-aware deferral — the declaring
 * ui-workspace entries may activate later, and an HMR collapse re-declares).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: () => ctx.workspaces.pickDirectory() })
  ctx.effect(() => {
    // Constructing the pair can throw halfway (a declared hole already
    // occupied registers synchronously): roll the earlier deferral back so
    // no live subscription outlives the failed fiber.
    const deferred: ReturnType<typeof deferRegistration>[] = []
    try {
      deferred.push(deferRegistration(ctx.slots, 'conversation.hero.workspace.directoryFlow', NativeDirectoryFlow, () =>
        ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, NativeDirectoryFlow)))
      deferred.push(deferRegistration(ctx.slots, 'sidebar.workspaces.directoryFlow', NativeDirectoryFlow, () =>
        ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, NativeDirectoryFlow)))
    } catch (error) {
      for (const entry of deferred) entry.dispose()
      throw error
    }
    return () => { for (const entry of deferred) entry.dispose() }
  }, 'directory-picker-native: flow registrations')
}
