import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Cron } from 'croner'
import {
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createCronScheduleRecord,
  decodeScheduleChange,
  foldScheduleEvents,
  resolveCronOccurrence,
  scheduleReminderPresentation,
  scheduleView,
} from '../src/domain.ts'

function event(data: unknown, seq: number): SessionEvent {
  return { type: 'schedule/change', seq, time: 0, data } as SessionEvent
}

function cronCreate(
  id = 'schedule-cron',
  scheduledAt = '2026-08-07T01:00:00.000Z',
  cron = '0 9 * * 1,2,3,4,5',
  timeZone = 'Asia/Shanghai',
) {
  return {
    version: 1,
    operation: 'create',
    schedule: { id, kind: 'cron', prompt: 'daily review', cron, timeZone, scheduledAt },
  }
}

function expectInputCode(run: () => unknown, code: ScheduleInputError['code']): void {
  try {
    run()
    throw new Error(`expected ${code}`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ScheduleInputError)
    expect((error as ScheduleInputError).code).toBe(code)
  }
}

describe('restricted cron grammar and frequency proof', () => {
  it.each([
    ['00 09 * * 1,2,3,4,5', '0 9 * * 1,2,3,4,5'],
    ['0 0 * */01 *', '0 0 * * *'],
    ['5-20/05 1-3 * * *', '5-20/5 1-3 * * *'],
    ['05 01 01,15 01,12 *', '5 1 1,15 1,12 *'],
    ['0 0 * * 7', '0 0 * * 7'],
    ['0 9 * * */7', '0 9 * * */7'],
  ])('canonicalizes %s', (input, canonical) => {
    expect(canonicalizeCronExpression(input)).toBe(canonical)
  })

  it.each([
    '',
    ' 0 0 * * *',
    '0 0 * * * ',
    '0 0 * *',
    '0 0 0 * * *',
    '@daily',
    '0 0 * JAN *',
    '0 0 * * MON',
    '0 0 ? * *',
    '0 0 L * *',
    '0 0 W * *',
    '0 0 * * 1#2',
    '-1 0 * * *',
    '1.5 0 * * *',
    '60 0 * * *',
    '0 24 * * *',
    '0 0 0 * *',
    '0 0 32 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '0,0 0 * * *',
    '2,1 0 * * *',
    '1,2-3 0 * * *',
    '2-2 0 * * *',
    '3-2 0 * * *',
    '*/0 0 * * *',
    '*/61 0 * * *',
    '1-5/61 0 * * *',
    '1-1/2 0 * * *',
    '0 0 * * 0,7',
    '0 0 * * 0-7',
    '0 0 * * */8',
    '0 0 * * 0-6/8',
    '0 0 * * 1-7/8',
    '0 0 1 * 1',
  ])('rejects unsupported grammar %s', (input) => {
    expectInputCode(() => canonicalizeCronExpression(input), 'invalid_rule')
  })

  it('proves same-day and cycle-seam frequency while allowing the five-minute boundary', () => {
    expectInputCode(() => canonicalizeCronExpression('0,4 * * * *'), 'frequency_too_high')
    expectInputCode(() => canonicalizeCronExpression('3,59 0,23 * * *'), 'frequency_too_high')
    expect(canonicalizeCronExpression('0,5 * * * *')).toBe('0,5 * * * *')
    expect(canonicalizeCronExpression('4,59 0,23 * * *')).toBe('4,59 0,23 * * *')
    expect(canonicalizeCronExpression('3,59 0,23 * * 1')).toBe('3,59 0,23 * * 1')
    expect(canonicalizeCronExpression('3,59 0,23 29 2 *')).toBe('3,59 0,23 29 2 *')
    expectInputCode(() => canonicalizeCronExpression('3,59 0,23 * * 5,6'), 'frequency_too_high')
    expect(canonicalizeCronExpression('* * 31 2 *')).toBe('* * 31 2 *')
  })
})

describe('Croner calendar adapter', () => {
  it('creates a canonical explicit-zone record and crosses from 2999 into 3000', () => {
    expect(createCronScheduleRecord(
      ScheduleId('schedule-workday'),
      '  review metrics  ',
      '00 09 * * 1,2,3,4,5',
      'US/Eastern',
      Date.parse('2026-08-06T12:00:00.000Z'),
    )).toEqual({
      id: 'schedule-workday',
      kind: 'cron',
      prompt: 'review metrics',
      cron: '0 9 * * 1,2,3,4,5',
      timeZone: 'America/New_York',
      scheduledAt: '2026-08-06T13:00:00.000Z',
    })
    expect(createCronScheduleRecord(
      ScheduleId('schedule-3000'),
      'new millennium',
      '0 0 1 1 *',
      'UTC',
      Date.parse('2999-12-31T23:59:59.999Z'),
    ).scheduledAt).toBe('3000-01-01T00:00:00.000Z')
  })

  it('owns forward and reverse calendar search across years 0001 through 0100', () => {
    expect(createCronScheduleRecord(
      ScheduleId('schedule-year-1'),
      'year one',
      '0 0 * * *',
      'UTC',
      Date.parse('0001-01-01T00:00:00.000Z'),
    ).scheduledAt).toBe('0001-01-02T00:00:00.000Z')
    expect(createCronScheduleRecord(
      ScheduleId('schedule-year-100'),
      'year one hundred',
      '0 0 * * *',
      'UTC',
      Date.parse('0099-12-31T00:00:00.000Z'),
    ).scheduledAt).toBe('0100-01-01T00:00:00.000Z')
    expect(createCronScheduleRecord(
      ScheduleId('schedule-low-leap'),
      'low leap',
      '0 0 29 2 *',
      'UTC',
      Date.parse('0001-01-01T00:00:00.000Z'),
    ).scheduledAt).toBe('0004-02-29T00:00:00.000Z')
    const historicalOffset = createCronScheduleRecord(
      ScheduleId('schedule-low-offset'),
      'low offset',
      '0 0 29 2 *',
      'Pacific/Kiritimati',
      Date.parse('0001-01-01T00:00:00.000Z'),
    )
    expect(new Date(historicalOffset.scheduledAt).getUTCFullYear()).toBeGreaterThan(109)
    const baseline = createCronScheduleRecord(
      ScheduleId('schedule-reverse-100'),
      'reverse one hundred',
      '0 0 * * *',
      'UTC',
      Date.parse('0099-12-30T00:00:00.000Z'),
    )
    expect(resolveCronOccurrence(baseline, Date.parse('0100-01-01T00:00:00.000Z'))).toEqual({
      occurrenceAt: '0100-01-01T00:00:00.000Z',
      nextScheduledAt: '0100-01-02T00:00:00.000Z',
    })
    const yearOne = createCronScheduleRecord(
      ScheduleId('schedule-reverse-1'),
      'reverse year one',
      '0 0 * * *',
      'UTC',
      Date.parse('0001-01-01T00:00:00.000Z'),
    )
    expect(resolveCronOccurrence(yearOne, Date.parse(yearOne.scheduledAt))).toEqual({
      occurrenceAt: yearOne.scheduledAt,
      nextScheduledAt: '0001-01-03T00:00:00.000Z',
    })
    expect(createCronScheduleRecord(
      ScheduleId('schedule-low-year-positive-offset-seam'),
      'positive offset seam',
      '0 0 1 1 *',
      'Etc/GMT-14',
      Date.parse('0108-12-31T23:59:59.999Z'),
    ).scheduledAt).toBe('0109-12-31T10:00:00.000Z')
  })

  it('skips a DST gap and chooses the first instant in an overlap', () => {
    const gap = createCronScheduleRecord(
      ScheduleId('schedule-gap'),
      'gap',
      '30 2 * * *',
      'America/New_York',
      Date.parse('2026-03-08T05:00:00.000Z'),
    )
    expect(gap.scheduledAt).toBe('2026-03-09T06:30:00.000Z')
    const gapBaseline = {
      ...gap,
      scheduledAt: '2026-03-07T07:30:00.000Z',
    }
    expect(resolveCronOccurrence(gapBaseline, Date.parse('2026-03-08T08:00:00.000Z'))).toEqual({
      occurrenceAt: gapBaseline.scheduledAt,
      nextScheduledAt: '2026-03-09T06:30:00.000Z',
    })

    const overlap = createCronScheduleRecord(
      ScheduleId('schedule-overlap'),
      'overlap',
      '30 1 * * *',
      'America/New_York',
      Date.parse('2026-10-31T06:00:00.000Z'),
    )
    expect(overlap.scheduledAt).toBe('2026-11-01T05:30:00.000Z')
    expect(resolveCronOccurrence({
      ...overlap,
      scheduledAt: '2026-10-31T05:30:00.000Z',
    }, Date.parse('2026-11-01T06:00:00.000Z'))).toEqual({
      occurrenceAt: '2026-11-01T05:30:00.000Z',
      nextScheduledAt: '2026-11-02T06:30:00.000Z',
    })
    expect(resolveCronOccurrence(overlap, Date.parse('2026-11-01T07:00:00.000Z'))).toEqual({
      occurrenceAt: '2026-11-01T05:30:00.000Z',
      nextScheduledAt: '2026-11-02T06:30:00.000Z',
    })
    expect(resolveCronOccurrence({
      ...overlap,
      cron: '0,30 1 * * *',
      scheduledAt: '2026-10-31T05:30:00.000Z',
    }, Date.parse('2026-11-01T07:00:00.000Z'))).toEqual({
      occurrenceAt: '2026-11-01T05:30:00.000Z',
      nextScheduledAt: '2026-11-02T06:00:00.000Z',
    })
    expect(createCronScheduleRecord(
      ScheduleId('schedule-overlap-after-first'),
      'after first overlap instant',
      '30 1 * * *',
      'America/New_York',
      Date.parse('2026-11-01T05:45:00.000Z'),
    ).scheduledAt).toBe('2026-11-02T06:30:00.000Z')
  })

  it('skips a sub-minute local-mean-time era before iterating dense safe-year matches', () => {
    const yearOne = createCronScheduleRecord(
      ScheduleId('schedule-sub-minute-offset-year-one'),
      'standard-time handoff',
      '*/5 * * * *',
      'Europe/Amsterdam',
      Date.parse('0001-01-01T00:00:00.000Z'),
    )
    const yearOneHundred = createCronScheduleRecord(
      ScheduleId('schedule-sub-minute-offset'),
      'standard-time handoff',
      '*/5 * * * *',
      'Europe/Amsterdam',
      Date.parse('0100-01-01T00:00:00.000Z'),
    )
    expect(yearOne.scheduledAt).toBe(yearOneHundred.scheduledAt)
    expect(new Date(yearOne.scheduledAt).getUTCFullYear()).toBeGreaterThan(109)
    expect(Math.abs(Date.parse(yearOne.scheduledAt) % 60_000)).toBe(0)
  }, 1_000)

  it('selects the latest current match after a persisted baseline', () => {
    const record = createCronScheduleRecord(
      ScheduleId('schedule-latest'),
      'latest',
      '0 9 * * *',
      'Asia/Shanghai',
      Date.parse('2026-08-01T00:00:00.000Z'),
    )
    expect(resolveCronOccurrence(record, Date.parse('2026-08-06T12:34:56.789Z'))).toEqual({
      occurrenceAt: '2026-08-06T01:00:00.000Z',
      nextScheduledAt: '2026-08-07T01:00:00.000Z',
    })
  })

  it('reports invalid zones, impossible calendars, and four-digit-year exhaustion', () => {
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('bad-prompt'), ' ', '0 0 * * *', 'UTC', Date.parse('2026-01-01T00:00:00Z'),
    ), 'invalid_prompt')
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('bad-zone'), 'x', '0 0 * * *', 'CST', Date.parse('2026-01-01T00:00:00Z'),
    ), 'invalid_time_zone')
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('no-date'), 'x', '* * 31 2 *', 'UTC', Date.parse('2026-01-01T00:00:00Z'),
    ), 'no_future_occurrence')
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('no-year'), 'x', '59 23 31 12 *', 'UTC', Date.parse('9999-12-31T23:59:00Z'),
    ), 'no_future_occurrence')
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('bad-now'), 'x', '0 0 * * *', 'UTC', Number.NaN,
    ), 'time_out_of_range')
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('last-now'), 'x', '0 0 * * *', 'UTC', Date.parse('9999-12-31T23:59:59.999Z'),
    ), 'no_future_occurrence')
  })

  it('contains invalid dependency results without replacing safe-year calendar search', () => {
    const record = createCronScheduleRecord(
      ScheduleId('schedule-dependency'),
      'dependency',
      '30 1 * * *',
      'America/New_York',
      Date.parse('2026-10-31T06:00:00.000Z'),
    )

    const noPrevious = vi.spyOn(Cron.prototype, 'previousRuns').mockReturnValue([])
    expect(resolveCronOccurrence(record, Date.parse(record.scheduledAt))).toMatchObject({
      occurrenceAt: record.scheduledAt,
    })
    noPrevious.mockRestore()

    const invalidNext = vi.spyOn(Cron.prototype, 'nextRun').mockReturnValue(new Date(Number.NaN))
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('invalid-next'), 'x', '0 0 * * *', 'UTC', Date.parse('2026-01-01T00:00:00Z'),
    ), 'invalid_rule')
    invalidNext.mockRestore()

    const outOfRangeNext = vi.spyOn(Cron.prototype, 'nextRun')
      .mockReturnValue(new Date('+010000-01-01T00:00:00.000Z'))
    expectInputCode(() => createCronScheduleRecord(
      ScheduleId('large-next'), 'x', '0 0 * * *', 'UTC', Date.parse('2026-01-01T00:00:00Z'),
    ), 'no_future_occurrence')
    outOfRangeNext.mockRestore()

    const invalidPrevious = vi.spyOn(Cron.prototype, 'previousRuns')
      .mockReturnValue([new Date(Number.NaN)])
    expect(() => resolveCronOccurrence(record, Date.parse('2026-11-01T07:00:00.000Z')))
      .toThrow(/cron evaluation failed: The cron evaluator did not retreat/)
    invalidPrevious.mockRestore()

    const thrownNext = vi.spyOn(Cron.prototype, 'nextRun').mockImplementation(() => {
      throw new Error('dependency failed')
    })
    expect(() => resolveCronOccurrence(record, Date.parse('2026-11-01T07:00:00.000Z')))
      .toThrow(/cron evaluation failed: dependency failed/)
    thrownNext.mockRestore()
  })
})

describe('durable Cron replay', () => {
  it('decodes canonical records and advances only from persisted dispatch facts', () => {
    const create = event(cronCreate(), 0)
    expect(decodeScheduleChange(create.data)).toEqual(cronCreate())
    const dispatch = event({
      version: 1,
      operation: 'dispatch',
      id: 'schedule-cron',
      occurrenceAt: '2026-08-08T01:00:00.000Z',
      acceptedAt: '2026-08-08T03:00:00.000Z',
      nextScheduledAt: '2026-08-11T01:00:00.000Z',
    }, 1)
    expect(foldScheduleEvents([create, dispatch])).toEqual({
      active: [{
        ...cronCreate().schedule,
        scheduledAt: '2026-08-11T01:00:00.000Z',
      }],
      seenIds: ['schedule-cron'],
      lastRecurringAcceptedAt: '2026-08-08T03:00:00.000Z',
    })
    expect(scheduleReminderPresentation([create, dispatch], 1)).toEqual({
      scheduleId: 'schedule-cron',
      prompt: 'daily review',
      occurrenceAt: '2026-08-08T01:00:00.000Z',
      deliveryMode: 'session-local',
    })
  })

  it('terminates at exhaustion and rejects mismatched or non-monotonic dispatches', () => {
    const create = event(cronCreate(), 0)
    const terminal = event({
      version: 1,
      operation: 'dispatch',
      id: 'schedule-cron',
      occurrenceAt: '2026-08-08T01:00:00.000Z',
      acceptedAt: '2026-08-08T03:00:00.000Z',
    }, 1)
    expect(foldScheduleEvents([create, terminal]).active).toEqual([])
    expect(() => foldScheduleEvents([
      create,
      event({ version: 1, operation: 'dispatch', id: 'schedule-cron', acceptedAt: '2026-08-08T03:00:00.000Z' }, 1),
    ])).toThrow(/cron dispatch must contain occurrenceAt/)
    expect(() => foldScheduleEvents([
      create,
      event({
        version: 1,
        operation: 'dispatch',
        id: 'schedule-cron',
        occurrenceAt: '2026-08-07T00:59:00.000Z',
        acceptedAt: '2026-08-08T03:00:00.000Z',
      }, 1),
    ])).toThrow(/monotonic progression/)
    expect(() => foldScheduleEvents([
      create,
      event({
        version: 1,
        operation: 'dispatch',
        id: 'schedule-cron',
        occurrenceAt: '2026-08-08T01:00:00.000Z',
        acceptedAt: '2026-08-08T03:00:00.000Z',
        nextScheduledAt: '2026-08-08T03:00:00.000Z',
      }, 1),
    ])).toThrow(/monotonic progression/)
    const decoded = decodeScheduleChange(cronCreate())
    if (decoded.operation !== 'create') throw new Error('expected decoded create')
    const decodedRecord = decoded.schedule
    if (decodedRecord.kind !== 'cron') throw new Error('expected decoded Cron record')
    expect(() => resolveCronOccurrence(decodedRecord, Number.NaN)).toThrow(/acceptedAt/)
    expect(() => resolveCronOccurrence(
      decodedRecord,
      Date.parse('2026-08-07T00:59:00.000Z'),
    )).toThrow(/cannot precede/)
  })

  it('shares gate projection and exhaustion with Every records', () => {
    const gateSource = {
      version: 1,
      operation: 'create',
      schedule: {
        id: 'schedule-gate',
        kind: 'every',
        prompt: 'gate',
        everySeconds: 300,
        scheduledAt: '2026-08-05T11:55:00.000Z',
      },
    }
    const activeCron = cronCreate('schedule-cron', '2026-08-05T12:03:00.000Z', '3 12 * * *', 'UTC')
    const folded = foldScheduleEvents([
      event(gateSource, 0),
      event({
        version: 1,
        operation: 'dispatch',
        id: 'schedule-gate',
        acceptedAt: '2026-08-05T12:00:00.000Z',
      }, 1),
      event({ version: 1, operation: 'delete', id: 'schedule-gate' }, 2),
      event(activeCron, 3),
    ])
    expect(scheduleView(
      folded.active[0]!,
      Date.parse('2026-08-05T12:03:00.000Z'),
      folded.lastRecurringAcceptedAt,
    )).toMatchObject({
      kind: 'cron',
      state: 'overdue',
      deliveryNotBefore: '2026-08-05T12:05:00.000Z',
    })

    const exhausted = foldScheduleEvents([
      event({
        ...gateSource,
        schedule: { ...gateSource.schedule, scheduledAt: '9999-12-31T23:55:00.000Z' },
      }, 0),
      event(cronCreate(
        'schedule-staggered-cron',
        '9999-12-31T23:58:00.000Z',
        '58 23 * * *',
        'UTC',
      ), 1),
      event({
        version: 1,
        operation: 'dispatch',
        id: 'schedule-gate',
        acceptedAt: '9999-12-31T23:57:30.000Z',
      }, 2),
    ])
    expect(exhausted.active).toEqual([])
  })

  it.each([
    { ...cronCreate(), schedule: { ...cronCreate().schedule, cron: '00 9 * * 1,2,3,4,5' } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, scheduledAt: '2026-08-07T01:00:01.000Z' } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, extra: true } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, prompt: '' } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, cron: 1 } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, timeZone: 1 } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, timeZone: 'CST' } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, cron: 'not cron' } },
    { ...cronCreate(), schedule: { ...cronCreate().schedule, kind: 'calendar' } },
  ])('rejects noncanonical durable Cron data %#', (data) => {
    expect(() => decodeScheduleChange(data)).toThrow(ScheduleLogError)
  })

  it('replays structural Cron facts without current frequency or ICU canonicalization', () => {
    expect(decodeScheduleChange(cronCreate(
      'schedule-legacy-zone',
      '2026-08-07T01:00:00.000Z',
      '* * 31 2 *',
      'Europe/Kyiv',
    ))).toMatchObject({
      operation: 'create',
      schedule: {
        id: 'schedule-legacy-zone',
        cron: '* * 31 2 *',
        timeZone: 'Europe/Kyiv',
      },
    })
  })
})
