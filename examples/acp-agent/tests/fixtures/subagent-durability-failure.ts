import type { Context } from 'cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'subagent-durability-failure'
export const inject = ['sessionPersistence', 'subagents']

/**
 * The authored parent transcript names the background child by a stable
 * placeholder id, but the live continuable child is minted with a fresh random
 * session id at run time. This snapshot-only overlay bridges that gap and forces
 * a deterministic ordering plus a failing final child durability checkpoint:
 *
 *  - `PLACEHOLDER_CHILD_ID` in a scripted `send_message` is remapped to the real
 *    child so both follow-ups queue onto the same live inbox in FIFO order.
 *  - The unknown-id `send_message` (`UNKNOWN_CHILD_ID`) resolves through a
 *    persistence load fenced behind both accepted follow-ups, so the transcript
 *    records the same order on every runner.
 *  - The child's final continuation turn fails its durability checkpoint with a
 *    fixed message, so the scenario proves child-first disposal survives a failed
 *    last flush.
 */
const PLACEHOLDER_CHILD_ID = '33333333-3333-4333-8333-333333333333'
const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'
/** The child continuation turn whose durability checkpoint is forced to fail. */
const FAILED_CHECKPOINT_TURN = 4

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

  // Remap the placeholder child id in a follow-up to the live child. The child
  // id the model "knows" is authored into the transcript, while the running
  // child is minted with a random id, so without this the follow-ups would
  // never reach the live inbox.
  let realChildId: string | undefined
  const subagents = ctx.subagents as unknown as {
    followup: (authority: unknown, childId: SessionId, content: unknown, options: unknown) => Promise<unknown>
  }
  const deliver = subagents.followup.bind(subagents)
  subagents.followup = (authority, childId, content, options) => {
    const mapped = childId === PLACEHOLDER_CHILD_ID && realChildId !== undefined
      ? SessionId(realChildId)
      : childId
    return deliver(authority, mapped, content, options)
  }

  // Both authored follow-ups reach the child inbox before the unknown-id lookup
  // runs, so the queued FIFO order is what the transcript records. The first
  // child enqueue is the initial delegation, which also pins the real child id.
  let accepted = 0
  ctx.on('agent/inbox/enqueue', (agent) => {
    if (agent.session.header.parentSession === undefined) return
    if (realChildId === undefined) realChildId = agent.session.header.id
    accepted += 1
    if (accepted >= 3) followupsAccepted.resolve(undefined)
  })

  // The child's ordinary per-turn flushes succeed; only the final continuation
  // turn's durability checkpoint fails, turning that turn/end into a durable
  // error the parent never sees.
  const childTurn = new WeakMap<object, number>()
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined || event.type !== 'turn/start') return
    childTurn.set(session, event.data.turn)
  })
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (childTurn.get(session) === FAILED_CHECKPOINT_TURN) throw new Error('snapshot disk full')
  })
}
