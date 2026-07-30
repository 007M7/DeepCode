import type { Context } from 'cordis'

export const name = 'subagent-durability-failure'
export const inject = ['sessionPersistence']

const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'

/** Fail the child checkpoint and stabilize the authored follow-up failure ordering. */
export function apply(ctx: Context): void {
  const followupsAccepted = Promise.withResolvers<undefined>()
  const persistence = ctx.sessionPersistence
  const load = persistence.load.bind(persistence)

  // The unavailable-child lookup is real asynchronous I/O. Fence it behind both
  // authored follow-ups so runner speed cannot reorder the exact log.
  persistence.load = async (id) => {
    if (id === UNKNOWN_CHILD_ID) await followupsAccepted.promise
    return load.call(persistence, id)
  }
  ctx.effect(() => () => {
    persistence.load = load
    followupsAccepted.resolve(undefined)
  }, 'subagent snapshot ordering')

  // Both authored follow-ups reach the child inbox before the unknown-id lookup
  // runs, so the queued FIFO order is what the transcript records.
  let accepted = 0
  ctx.on('agent/inbox/enqueue', (agent) => {
    if (agent.session.header.parentSession === undefined) return
    accepted += 1
    if (accepted >= 3) followupsAccepted.resolve(undefined)
  })

  const flushedTurnEnds = new WeakSet<object>()
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (session.events.at(-1)?.type !== 'turn/end') return
    if (flushedTurnEnds.has(session)) throw new Error('snapshot disk full')
    flushedTurnEnds.add(session)
  })
}
