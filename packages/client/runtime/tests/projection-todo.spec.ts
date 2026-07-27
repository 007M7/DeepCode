/**
 * Knife-4 acceptance probe (session-projection RFC): the todo domain's client
 * cell — `fromEvent: todo/write ⇒ whole list` — runs end to end on the
 * UNMODIFIED cell framework: baseline seeding from a history response's
 * projections block, live last-wins folding, and the seq guard, with the
 * `todos` key merged test-locally the same way the domain client plugin will
 * (through the interface package's pure-type outlet). Zero framework edits.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { TodoItem } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { ProjectionCellSpec } from '../src/client/sessions/projection-cell.ts'
import { Session } from '../src/client/sessions/session.ts'
import { FakeApiClient, ok } from './fake-api.ts'
import { entries, plainTurn } from './event-script.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    todos: TodoItem[] | null
  }
}

const SID = 'fk-todo' as SessionId

const todoEvent = (seq: number, todos: TodoItem[]): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type: 'todo/write', data: { todos } }) as unknown as SessionEvent

/** The exact cell the todo domain client plugin will register: whole-list fromEvent, array-or-null schema. */
const todosSpec = (): ProjectionCellSpec<'todos'> => ({
  key: 'todos',
  schema: {
    parse: (value) => {
      if (value === null || Array.isArray(value)) return value as TodoItem[] | null
      throw new Error('not a todos payload')
    },
  },
  fromEvent: event => (event.type === 'todo/write'
    ? (event as unknown as { data: { todos: TodoItem[] } }).data.todos
    : undefined),
})

function makeSession() {
  const api = new FakeApiClient()
  const session = new Session(SID, api)
  session.projections.register(todosSpec())
  const cell = session.projections.cellOf('todos')
  if (cell === undefined) throw new Error('cell missing after register')
  return { api, session, cell }
}

describe('todo projection cell over the unmodified framework', () => {
  it('seeds null from a pre-first-write baseline, then a live todo/write replaces it whole', async () => {
    const { api, session, cell } = makeSession()
    api.onHistory = () => Promise.resolve(ok({
      events: entries(plainTurn(0, 0, 'q', 'a')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { todos: null } },
    } as never))
    await session.open()
    expect(cell.getSnapshot()).toBeNull()
    const list: TodoItem[] = [{ content: 'ship knife 4', status: 'in_progress' }]
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: todoEvent(6, list) })
    expect(cell.getSnapshot()).toEqual(list)
  })

  it('seeds the whole list from the baseline and drops a replayed older snapshot (last-wins)', async () => {
    const { api, session, cell } = makeSession()
    const current: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]
    api.onHistory = () => Promise.resolve(ok({
      events: entries(plainTurn(0, 0, 'q', 'a')) as never[], hasMore: false,
      projections: { asOfSeq: 9, values: { todos: current } },
    } as never))
    await session.open()
    expect(cell.getSnapshot()).toEqual(current)
    // A replayed pre-cut write (window path) must not roll the list back.
    session.projections.offerWindow([todoEvent(4, [{ content: 'stale', status: 'pending' }])])
    expect(cell.getSnapshot()).toEqual(current)
  })

  it('reads capability-absent (undefined) when the block omits the todos key', async () => {
    const { api, session, cell } = makeSession()
    api.onHistory = () => Promise.resolve(ok({
      events: entries(plainTurn(0, 0, 'q', 'a')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: {} },
    } as never))
    await session.open()
    expect(cell.getSnapshot()).toBeUndefined()
  })
})
