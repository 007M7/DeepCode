/**
 * Browser trajectory plugin contributing one entry to the conversation view
 * slot without defining a service.
 */
import type { Context } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'

/**
 * Required services (cordis fiber inject). 'conversation' is an ordering
 * edge, not a call dependency: the 'conversation.view' slot is declared by
 * ui-conversation's apply (which then provides the service), and register()
 * into an undeclared slot throws — service waiting is what orders this
 * apply after the declaring one.
 */
export const inject = ['slots', 'conversation', 'sessionHistory']

/**
 * Client plugin body: register the trajectory view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.register({
    name: 'conversation.view',
    id: 'trajectory',
    order: 10,
    label: 'Trajectory',
    inject: (sessionId: SessionId): TrajectoryViewInjected => {
      const history = ctx.sessionHistory.source(sessionId)
      return {
        hooks: { history },
        loadAllHistory: signal => history.loadAll(signal),
      }
    },
  }, TrajectoryView)
}
