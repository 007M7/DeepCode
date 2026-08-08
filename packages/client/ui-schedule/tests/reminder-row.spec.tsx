// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PresentedEventNode } from '@deepseek-ai/dsh-client-runtime/client'
import { ReminderRow, type ReminderRowProps } from '../src/client/ReminderRow.tsx'
import { zh } from '../src/client/locales.ts'

const t: ReminderRowProps['t'] = makeTranslate(zh)

const invalidSidecars: ReadonlyArray<{ name: string; view: unknown }> = [
  { name: 'non-object', view: undefined },
  { name: 'null', view: null },
  { name: 'array', view: [] },
  {
    name: 'missing schedule id',
    view: {
      scheduleId: null,
      prompt: 'not trusted',
      occurrenceAt: '2026-08-05T08:00:00.000Z',
    },
  },
  {
    name: 'empty schedule id',
    view: {
      scheduleId: '',
      prompt: 'not trusted',
      occurrenceAt: '2026-08-05T08:00:00.000Z',
    },
  },
  {
    name: 'non-string prompt',
    view: {
      scheduleId: 'schedule-7',
      prompt: 7,
      occurrenceAt: '2026-08-05T08:00:00.000Z',
    },
  },
  {
    name: 'non-string occurrence',
    view: {
      scheduleId: 'schedule-7',
      prompt: 'not trusted',
      occurrenceAt: 7,
    },
  },
  {
    name: 'empty occurrence',
    view: {
      scheduleId: 'schedule-7',
      prompt: 'not trusted',
      occurrenceAt: '',
    },
  },
]

afterEach(cleanup)

function props(view: unknown): ReminderRowProps {
  const node: PresentedEventNode = {
    kind: 'presented-event',
    seq: 4,
    time: Date.parse('2026-08-05T08:00:00.000Z'),
    eventType: 'schedule/change',
    view,
  }
  return { node, t } as ReminderRowProps
}

describe('ReminderRow', () => {
  it('shows the durable reminder payload and its session-local boundary', () => {
    render(<ReminderRow {...props({
      scheduleId: 'schedule-7',
      prompt: 'Check the deploy',
      occurrenceAt: '2026-08-05T08:00:00.000Z',
    })} />)

    expect(screen.getByRole('note')).toBeTruthy()
    expect(screen.getByText('定时提醒')).toBeTruthy()
    expect(screen.getByText('仅在当前会话中交付')).toBeTruthy()
    expect(screen.getByText('Check the deploy')).toBeTruthy()
    expect(screen.getByText('编号 schedule-7')).toBeTruthy()
    const time = screen.getByText('触发时间 2026-08-05T08:00:00.000Z')
    expect(time.getAttribute('datetime')).toBe('2026-08-05T08:00:00.000Z')
  })

  it.each(invalidSidecars)('contains an incompatible $name sidecar as an unavailable receipt', ({ view }) => {
    render(<ReminderRow {...props(view)} />)

    expect(screen.getByText('提醒回执不可用 · schedule/change')).toBeTruthy()
    expect(screen.queryByText('not trusted')).toBeNull()
    expect(screen.queryByText('仅在当前会话中交付')).toBeNull()
  })
})
