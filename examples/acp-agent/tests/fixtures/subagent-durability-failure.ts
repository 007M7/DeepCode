import type { Context } from 'cordis'
import { appendFileSync } from 'node:fs'

export const name = 'subagent-durability-failure'
export const inject = ['sessionPersistence', 'subagents']

const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'

/** Fail the child checkpoint and stabilize the authored follow-up failure ordering. */
export function apply(ctx: Context): void {
  const log = (...a: unknown[]): void => {
    try { appendFileSync('/tmp/probe.log', '[PROBE] ' + a.map(String).join(' ') + '\n') } catch { /* ignore */ }
  }
  const followupsAccepted = Promise.withResolvers<undefined>()
  const persistence = ctx.sessionPersistence
  const load = persistence.load.bind(persistence)

  persistence.load = async (id) => {
    log('load', id)
    if (id === UNKNOWN_CHILD_ID) { log('gating unknown-id load'); await followupsAccepted.promise; log('unknown-id load released') }
    return load.call(persistence, id)
  }

  // Patch followup to log routing.
  const subagents = ctx.subagents as unknown as { followup: (...a: unknown[]) => Promise<unknown> }
  const origFollowup = subagents.followup.bind(subagents)
  subagents.followup = async (...args: unknown[]) => {
    log('followup childId=', args[1])
    return origFollowup(...args)
  }

  ctx.effect(() => () => {
    persistence.load = load
    followupsAccepted.resolve(undefined)
  }, 'subagent snapshot ordering')

  let accepted = 0
  ctx.on('agent/inbox/enqueue', (agent) => {
    if (agent.session.header.parentSession === undefined) return
    accepted += 1
    log('child enqueue #', accepted, 'child=', agent.session.header.id)
    if (accepted >= 3) followupsAccepted.resolve(undefined)
  })

  ctx.on('subagent/start', (info: unknown) => {
    log('subagent/start id=', (info as { id?: unknown }).id)
  })

  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined) return
    if (event.type === 'turn/start') log('child turn/start turn=', event.data.turn, 'child=', session.header.id)
    if (event.type === 'user/message') {
      const c = event.data.content?.[0]
      log('child user/message text=', c && c.type === 'text' ? c.text : '?', 'child=', session.header.id)
    }
  })

  const flushes = new WeakMap<object, number>()
  const flushedTurnEnds = new WeakSet<object>()
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    const count = (flushes.get(session) ?? 0) + 1
    flushes.set(session, count)
    log('child flush #', count, 'child=', session.header.id)
    if (session.events.at(-1)?.type !== 'turn/end') return
    if (flushedTurnEnds.has(session)) {
      log('THROW snapshot disk full')
      throw new Error('snapshot disk full')
    }
    flushedTurnEnds.add(session)
  })
}
