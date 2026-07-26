/**
 * Browser trajectory plugin contributing two entries to the conversation
 * view slot without defining a service.
 */
import type { Context } from 'cordis'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TrajectoryView } from './TrajectoryView.tsx'
import { WaterfallView } from './WaterfallView.tsx'

/**
 * Required services (cordis fiber inject). 'conversation' is an ordering
 * edge, not a call dependency: the 'conversation.view' slot is declared by
 * ui-conversation's apply (which then provides the service), and register()
 * into an undeclared slot throws — service waiting is what orders this
 * apply after the declaring one.
 */
export const inject = ['slots', 'conversation']

/**
 * Client plugin body: register the trajectory and waterfall view tabs. The
 * registrations ride the slot service's effect wrapper (plugin unload
 * removes both tabs).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.register(
    { name: 'conversation.view', id: 'trajectory', order: 10, label: 'Trajectory' }, TrajectoryView)
  ctx.slots.register(
    { name: 'conversation.view', id: 'waterfall', order: 20, label: 'Waterfall' }, WaterfallView)
}
