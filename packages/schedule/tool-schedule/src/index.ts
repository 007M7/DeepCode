/**
 * Agent-scoped durable after reminders over the session event log.
 * @module @deepseek-ai/dsh-tool-schedule
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { ScheduleOwner } from './runtime.ts'
import { registerScheduleTools } from './tools.ts'

export type * from './types.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  allocateScheduleId,
  createAfterScheduleRecord,
  decodeScheduleChange,
  foldScheduleEvents,
  renderReminderFraming,
  scheduleView,
} from './domain.ts'
export { registerScheduleTools } from './tools.ts'

/** Cordis function-plugin name. */
export const name = 'tool-schedule'
/** Services required before future root agents can receive Schedule. */
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']

type OwnerCleanup = () => void | Promise<void>

/** Install Schedule only for root agents published after this plugin loads. */
export function apply(ctx: Context): void {
  const owners = new Map<Agent, OwnerCleanup>()
  let stopping = false

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || owners.has(agent) || !ctx.agents.roots().includes(agent)) return
      const owner = new ScheduleOwner(ctx, agent)
      const cleanup: OwnerCleanup = agent.ctx.effect(() => {
        const disposeTools = registerScheduleTools(ctx, agent.ctx, agent, () => { owner.requestDrive() })
        const stopStatus = agent.ctx.on('agent/status', ({ status }) => {
          if (status === 'idle' && agent.session.events.some(event => event.type === 'schedule/change')) {
            owner.requestDrive()
          }
        })
        owner.start()
        return async () => {
          stopStatus()
          disposeTools()
          try {
            await owner.dispose()
          } finally {
            if (owners.get(agent) === cleanup) owners.delete(agent)
          }
        }
      }, 'tool-schedule.owner()')
      owners.set(agent, cleanup)
    })

    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...owners.values()]
      owners.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'tool-schedule.lifecycle()')
}
