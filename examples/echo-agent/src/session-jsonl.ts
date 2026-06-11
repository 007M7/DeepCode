import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'session-jsonl'
export const inject = ['sessions']

/**
 * Minimal persistence plugin: buffers session events (write-behind) and
 * drains to a JSONL file at every `session/flush` checkpoint — the pattern a
 * real JSONL/sqlite persistence plugin would follow.
 */
export function apply(ctx: Context) {
  const buffers = new Map<Session, SessionEvent[]>()
  const path = (session: Session) => join(import.meta.dirname, '..', `${session.id}.jsonl`)

  ctx.on('session/event', (session, event) => {
    let buffer = buffers.get(session)
    if (!buffer) buffers.set(session, buffer = [])
    buffer.push(event)
  })

  const flush = async (session: Session) => {
    const buffer = buffers.get(session)
    if (!buffer?.length) return
    const lines = buffer.splice(0).map(event => JSON.stringify(event) + '\n').join('')
    await appendFile(path(session), lines)
  }

  ctx.on('session/flush', flush)
  ctx.effect(() => () => {
    // drain remaining buffers on dispose
    for (const session of buffers.keys()) void flush(session)
  }, 'session-jsonl')
}
