/**
 * Plan control plugin, browser half: occupies the composer's named
 * `conversation.input.plan` seat with a pending-aware mode selector. Reads
 * ride the generic projection pair — the control renders the `plan`
 * projection through the standard-kit `useProjection` (an absent key is
 * capability absence and hides the control); writes ride the standard
 * command channel — selecting a mode executes `/plan` / `/plan off` through
 * `command.execute`, whose logged lifecycle plus the boundary `plan/mode`
 * commit come back as projection frames. Zero client-side plan state.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import { PlanModeControl } from './PlanModeControl.tsx'

/** Injected business face of the composer plan seat. */
export interface PlanModeControlInjected {
  /**
   * Select the target mode by executing the corresponding /plan line.
   * @param active - whether plan mode should be active from the next boundary.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  setPlanMode: (active: boolean) => Promise<string | null>
}

/**
 * Required services: the seat's slot registry, the transport, and the
 * conversation service whose presence guarantees the seat is declared.
 */
export const inject = ['slots', 'connection', 'conversation']

/**
 * Client plugin body: register the plan seat occupant over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.register({
    name: 'conversation.input.plan',
    inject: (sessionId: SessionId): PlanModeControlInjected => ({
      setPlanMode: async (active) => {
        const connection = ctx.get('connection') as ConnectionHandle
        const line = active ? '/plan' : '/plan off'
        const { result } = await connection.api.commands.execute({ sessionId, line })
        if (!result.ok) return `${result.error.message}（${result.error.code}）`
        if (!result.value.matched) return `未知命令：${line}`
        return null
      },
    }),
  }, PlanModeControl), 'ui-plan: composer plan seat registration')
}
