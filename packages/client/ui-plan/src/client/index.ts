/**
 * Plan control plugin, browser half: occupies the composer's named
 * `conversation.input.plan` seat with a read-only status chip. Plan mode is
 * entered through the /plan command only; while the projection's effective
 * target is plan mode the chip renders (hover × executes /plan off through
 * `command.execute`), otherwise the seat stays empty. Reads ride the generic
 * projection pair through the standard-kit `useProjection` (an absent key is
 * capability absence); zero client-side plan state.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `plan` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-plan-mode/client'
import { PlanChip } from './PlanModeControl.tsx'

/** Injected business face of the composer plan seat. */
export interface PlanChipInjected {
  /**
   * Leave plan mode by executing /plan off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitPlanMode: () => Promise<string | null>
}

/**
 * Required services: the seat's slot registry, the transport, and the
 * conversation service whose presence guarantees the seat is declared.
 */
export const inject = ['slots', 'connection', 'conversation']

/**
 * Client plugin body: register the plan chip over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.register({
    name: 'conversation.input.plan',
    inject: (sessionId: SessionId): PlanChipInjected => ({
      exitPlanMode: async () => {
        const connection = ctx.get('connection') as ConnectionHandle
        const { result } = await connection.api.commands.execute({ sessionId, line: '/plan off' })
        if (!result.ok) return `${result.error.message}（${result.error.code}）`
        if (!result.value.matched) return '未知命令：/plan off'
        return null
      },
    }),
  }, PlanChip), 'ui-plan: composer plan chip registration')
}
