import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionTitleService, { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function appendPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const session = ctx.sessions.create(id)
  session.append('turn/start', {
    turn: 1,
    trigger: { kind: 'message', source: { kind: 'user' } },
  })
  session.append('user/message', {
    content: [{ type: 'text', text: 'Persist this session title' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  await new Promise(resolve => setTimeout(resolve, 0))
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.parallel('session/flush', session)
}

async function expectPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>): Promise<void> {
  const loaded = await ctx.sessionPersistence.load(id)
  expect(foldSessionTitle(loaded.events)).toMatchObject({
    title: 'Persist this session title',
    messageSeqs: [1],
    source: { kind: 'fallback' },
    eventSeq: 2,
  })
  expect(loaded.events.map(event => event.type)).toEqual([
    'turn/start',
    'user/message',
    'session/title',
    'turn/end',
  ])
}

describe('session title persistence round trips', () => {
  it('round-trips through a remounted JSONL backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-jsonl-'))
    roots.push(root)
    const id = SessionId('title-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
    await expectPersistedTitle(reader, id)
    await reader.fiber.dispose()
  })

  it('round-trips through a remounted SQLite backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-sqlite-'))
    roots.push(root)
    const path = join(root, 'sessions.db')
    const id = SessionId('title-sqlite')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionPersistenceSqlite, { path })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionPersistenceSqlite, { path })
    await expectPersistedTitle(reader, id)
    await reader.fiber.dispose()
  })
})
