import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as scheduleInvariant from '../src/invariant.ts'
import { createCronScheduleRecord, resolveCronOccurrence, ScheduleId } from '../src/domain.ts'
import type { ScheduleChange } from '../src/types.ts'

function event(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: 1, data } as SessionEvent
}

function create(id: string): ScheduleChange {
  return {
    version: 1,
    operation: 'create',
    schedule: {
      id: ScheduleId(id),
      kind: 'after',
      prompt: 'check logs',
      afterSeconds: 1,
      scheduledAt: '2026-08-05T12:00:01.000Z',
    },
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService)
  const fiber = await ctx.plugin(scheduleInvariant)
  return { ctx, fiber }
}

describe('Schedule package invariant', () => {
  it('accepts valid candidates and rejects invalid transitions before append', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('schedule-invariant'))
    session.append('turn/start', { turn: 1 })
    session.append('schedule/change', create('schedule-1'))
    expect(session.events).toHaveLength(2)

    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'delete',
      id: ScheduleId('missing'),
    })).toThrow(InvariantError)
    expect(session.events).toHaveLength(2)

    session.append('schedule/change', { version: 1, operation: 'dispatch', id: ScheduleId('schedule-1') })
    expect(session.events).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('validates live Cron records and dispatches with current calendar data', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('schedule-live-cron-invariant'))
    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: {
        id: ScheduleId('schedule-invalid-live-cron'),
        kind: 'cron',
        prompt: 'invalid current target',
        cron: '0 9 * * *',
        timeZone: 'UTC',
        scheduledAt: '2026-08-06T12:00:00.000Z',
      },
    })).toThrow(InvariantError)
    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: {
        id: ScheduleId('schedule-alias-live-cron'),
        kind: 'cron',
        prompt: 'noncanonical zone',
        cron: '0 9 * * *',
        timeZone: 'US/Eastern',
        scheduledAt: '2026-08-06T13:00:00.000Z',
      },
    })).toThrow(InvariantError)
    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: {
        id: ScheduleId('schedule-fast-live-cron'),
        kind: 'cron',
        prompt: 'too frequent',
        cron: '* * * * *',
        timeZone: 'UTC',
        scheduledAt: '2026-08-06T12:00:00.000Z',
      },
    })).toThrow(InvariantError)

    const record = createCronScheduleRecord(
      ScheduleId('schedule-valid-live-cron'),
      'valid current target',
      '0 9 * * *',
      'UTC',
      Date.parse('2026-08-06T08:00:00.000Z'),
    )
    session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
    const acceptedAt = '2026-08-07T12:00:00.000Z'
    const expected = resolveCronOccurrence(record, Date.parse(acceptedAt))
    expect(() => session.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: record.id,
      occurrenceAt: record.scheduledAt,
      acceptedAt,
      nextScheduledAt: expected.nextScheduledAt,
    })).toThrow(InvariantError)
    expect(session.events).toHaveLength(1)
    session.append('schedule/change', {
      version: 1,
      operation: 'dispatch',
      id: record.id,
      occurrenceAt: expected.occurrenceAt,
      acceptedAt,
      nextScheduledAt: expected.nextScheduledAt,
    })
    expect(session.events).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('keeps existing Cron replay structural across time-zone data changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService)
    ctx.sessions.create(SessionId('schedule-historical-cron-invariant'), {
      seed: [event({
        version: 1,
        operation: 'create',
        schedule: {
          id: 'schedule-historical-cron',
          kind: 'cron',
          prompt: 'historical target',
          cron: '0 9 * * *',
          timeZone: 'UTC',
          scheduledAt: '2026-08-06T12:00:00.000Z',
        },
      }, 0)],
    })
    const fiber = await ctx.plugin(scheduleInvariant)
    const invalidLiveRules = [
      {
        id: 'schedule-historical-fast-cron',
        cron: '* * * * *',
        scheduledAt: '2026-08-06T12:00:00.000Z',
        occurrenceAt: '2026-08-06T12:01:00.000Z',
        acceptedAt: '2026-08-06T12:01:00.000Z',
        nextScheduledAt: '2026-08-06T12:02:00.000Z',
      },
      {
        id: 'schedule-historical-impossible-cron',
        cron: '0 0 31 2 *',
        scheduledAt: '2026-02-01T00:00:00.000Z',
        occurrenceAt: '2026-02-01T00:00:00.000Z',
        acceptedAt: '2026-02-01T00:00:00.000Z',
        nextScheduledAt: undefined,
      },
    ] as const
    for (const invalid of invalidLiveRules) {
      const replay = ctx.sessions.create(SessionId(invalid.id), {
        seed: [event({
          version: 1,
          operation: 'create',
          schedule: {
            id: invalid.id,
            kind: 'cron',
            prompt: 'historical rule',
            cron: invalid.cron,
            timeZone: 'UTC',
            scheduledAt: invalid.scheduledAt,
          },
        }, 0)],
      })
      expect(() => replay.append('schedule/change', {
        version: 1,
        operation: 'dispatch',
        id: ScheduleId(invalid.id),
        occurrenceAt: invalid.occurrenceAt,
        acceptedAt: invalid.acceptedAt,
        ...(invalid.nextScheduledAt === undefined ? {} : { nextScheduledAt: invalid.nextScheduledAt }),
      })).toThrow(InvariantError)
    }
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a malformed existing owned stream during companion setup', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService)
    ctx.sessions.create(SessionId('schedule-invalid-seed'), {
      seed: [event({ version: 9, operation: 'delete', id: 'schedule-1' }, 0)],
    })
    await expect(ctx.plugin(scheduleInvariant).then(() => undefined)).rejects.toThrow(InvariantError)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed seeded session created after companion setup', async () => {
    const { ctx } = await harness()
    const id = SessionId('schedule-invalid-future-seed')
    expect(() => ctx.sessions.create(id, {
      seed: [event({ version: 9, operation: 'delete', id: 'schedule-1' }, 0)],
    })).toThrow(InvariantError)
    expect(ctx.sessions.get(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('ignores inherited Schedule events before a fork seed boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService)
    const child = ctx.sessions.create(SessionId('schedule-fork'), {
      seed: [event({ version: 9, operation: 'delete', id: 'parent' }, 0)],
      meta: { parentSession: SessionId('parent'), seedLength: 1 },
    })
    const fiber = await ctx.plugin(scheduleInvariant)
    child.append('schedule/change', create('child'))
    expect(child.events.at(-1)?.data).toMatchObject({ operation: 'create' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
