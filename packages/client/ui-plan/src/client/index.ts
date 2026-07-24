/**
 * Web plan plugin, browser half: contributes one pending-aware selector to
 * the default composer's additive controls slot.
 */
import type {
  ClientContext, SessionId, SessionsService,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerControlProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PlanModeControl } from './PlanModeControl.tsx'

/** Callback share injected into the pure control component. */
export interface PlanModeControlInjected {
  /** Select the target mode; null means success, a string is user-visible failure detail. */
  setPlanMode(active: boolean): Promise<string | null>
}

/** Complete props assembled for the composer-control entry. */
export type PlanModeControlProps = ComposerControlProps & PlanModeControlInjected

/**
 * Required services. `conversation` is the ordering edge that guarantees the
 * composer-controls slot has been declared before this plugin registers.
 */
export const inject = ['slots', 'sessions', 'conversation']

/**
 * Register the plan selector and bridge its callback to the session object.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // This dual-half package also imports the host plan service, whose program
  // carries the host-side `sessions` merge. Resolve and narrow the browser
  // service at the client entry seam instead of relying on that shared key.
  const sessions = ctx.get('sessions') as unknown as SessionsService
  ctx.slots.register({
    name: 'conversation.composer.controls',
    id: 'plan-mode',
    order: 10,
    inject: (sessionId: SessionId): PlanModeControlInjected => ({
      setPlanMode: async (active) => {
        const result = await sessions.manager.get(sessionId).setPlanMode(active)
        return result.ok ? null : `${result.error.message}（${result.error.code}）`
      },
    }),
  }, PlanModeControl)
}
