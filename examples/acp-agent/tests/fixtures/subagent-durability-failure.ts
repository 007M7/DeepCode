import type { Context } from 'cordis'

export const name = 'subagent-durability-failure'
export const inject = ['sessionPersistence', 'tasks']

const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'
const FOLLOW_UP_TASK_ID = 'subagent-2'

/** Fail the child checkpoint and stabilize the authored follow-up failure ordering. */
export function apply(ctx: Context): void {
  const thirdStepEnded = Promise.withResolvers<undefined>()
  const followUpSettled = Promise.withResolvers<undefined>()
  const persistence = ctx.sessionPersistence
  const load = persistence.load.bind(persistence)

  // The unavailable-child lookup is real asynchronous I/O. Fence it between
  // the authored step boundaries so runner speed cannot reorder the exact log.
  persistence.load = async (id) => {
    if (id === UNKNOWN_CHILD_ID) await thirdStepEnded.promise
    return load.call(persistence, id)
  }
  ctx.effect(() => () => {
    persistence.load = load
    thirdStepEnded.resolve(undefined)
    followUpSettled.resolve(undefined)
  }, 'subagent snapshot ordering')

  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined
      && event.type === 'step/end'
      && event.data.turn === 1
      && event.data.step === 3) {
      thirdStepEnded.resolve(undefined)
    }
  })
  ctx.tasks.onTaskDone((snapshot) => {
    if (snapshot.id === FOLLOW_UP_TASK_ID) followUpSettled.resolve(undefined)
  })
  ctx.on('agent/step', async (agent, turn, step) => {
    if (agent.session.header.parentSession === undefined && turn === 1 && step === 4) {
      await followUpSettled.promise
    }
  })

  const flushedTurnEnds = new WeakSet<object>()
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (session.events.at(-1)?.type !== 'turn/end') return
    if (flushedTurnEnds.has(session)) throw new Error('snapshot disk full')
    flushedTurnEnds.add(session)
  })
}
