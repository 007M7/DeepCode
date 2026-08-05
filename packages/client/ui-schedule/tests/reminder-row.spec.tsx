// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PresentedEventNode } from '@deepseek-ai/dsh-client-runtime/client'
import { ReminderRow, type ReminderRowProps } from '../src/client/ReminderRow.tsx'
import { zh } from '../src/client/locales.ts'

const t: ReminderRowProps['t'] = makeTranslate(zh)

afterEach(cleanup)

function props(view: unknown): ReminderRowProps {
  const node: PresentedEventNode = {
    kind: 'presented-event',
    seq: 4,
    time: Date.parse('2026-08-05T08:00:00.000Z'),
    presentationKey: 'schedule/reminder',
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
      deliveryMode: 'session-local',
    })} />)

    expect(screen.getByRole('note')).toBeTruthy()
    expect(screen.getByText('定时提醒')).toBeTruthy()
    expect(screen.getByText('仅在当前会话中交付')).toBeTruthy()
    expect(screen.getByText('Check the deploy')).toBeTruthy()
    expect(screen.getByText('编号 schedule-7')).toBeTruthy()
    const time = screen.getByText('触发时间 2026-08-05T08:00:00.000Z')
    expect(time.getAttribute('datetime')).toBe('2026-08-05T08:00:00.000Z')
  })

  it('contains an incompatible sidecar as a visible unavailable receipt', () => {
    render(<ReminderRow {...props({
      scheduleId: '',
      prompt: 'not trusted',
      occurrenceAt: 123,
      deliveryMode: 'external',
    })} />)

    expect(screen.getByText('提醒回执不可用 · schedule/reminder')).toBeTruthy()
    expect(screen.queryByText('not trusted')).toBeNull()
    expect(screen.queryByText('仅在当前会话中交付')).toBeNull()
  })
})
