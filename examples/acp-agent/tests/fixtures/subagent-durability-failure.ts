import type { Context } from 'cordis'

export const name = 'subagent-durability-failure'

/** Fail a continuable child's provider-owned final durability confirmation. */
export function apply(ctx: Context): void {
  const flushedTurnEnds = new WeakSet<object>()
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (session.events.at(-1)?.type !== 'turn/end') return
    if (flushedTurnEnds.has(session)) throw new Error('snapshot disk full')
    flushedTurnEnds.add(session)
  })
}
