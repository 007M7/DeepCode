// @vitest-environment jsdom
/** Trajectory ledger selection, details, status, and fold behavior. */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'

afterEach(cleanup)

const TURNS: readonly TrajectoryTurnModel[] = [{
  turn: 1,
  groups: [{
    title: 'Step 1',
    description: '1.5s bash×2',
    cells: [
      {
        index: 1,
        kind: 'message',
        text: 'Checking files',
        outputDetail: 'Checking files',
        input: 10,
        output: 20,
        think: 5,
        timeSeconds: 1.5,
        assistantMetrics: {
          timingRecorded: true,
          stepStartTime: 1_000,
          firstTokenTime: 1_500,
          completedTime: 2_500,
          usageProvided: true,
          outputTokens: 20,
        },
      },
      {
        index: 2,
        kind: 'tool',
        text: 'bash · {"command":"pwd"}',
        inputDetail: '{"command":"pwd"}',
        timeSeconds: null,
      },
      {
        index: 3,
        kind: 'tool',
        text: 'bash · {"command":"false"}',
        inputDetail: '{"command":"false"}',
        outputDetail: 'ToolError: non_zero_exit',
        result: 'non_zero_exit',
        isError: true,
        timeSeconds: 0.2,
      },
    ],
  }],
}]

describe('TrajectoryTable', () => {
  it('shows assistant timing facts after keyboard selection', () => {
    render(<TrajectoryTable turns={TURNS} collapsed={false} />)
    fireEvent.keyDown(screen.getByRole('row', { name: /记录 1，ASSISTANT/ }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('tab', { name: '计时' }))

    expect(screen.getByText('500 ms')).toBeTruthy()
    expect(screen.getByText('1.00 s')).toBeTruthy()
    expect(screen.getByText('20.0 tok/s')).toBeTruthy()
  })

  it('keeps running and failure semantics distinct from record roles', () => {
    const view = render(<TrajectoryTable turns={TURNS} collapsed={false} />)
    expect(view.container.querySelector('tr[data-kind="tool"][data-running="true"]')).toBeTruthy()
    expect(view.container.querySelector('tr[data-kind="tool"][data-error="true"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('row', { name: /记录 2，TOOL/ }))
    expect(screen.getByText('进行中')).toBeTruthy()
    fireEvent.click(screen.getByRole('row', { name: /记录 3，TOOL/ }))
    expect(screen.getByText('失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '输出' }))
    expect(screen.getByText('ToolError: non_zero_exit')).toBeTruthy()
  })

  it('retains the ledger header and record count when collapsed', () => {
    render(<TrajectoryTable turns={TURNS} collapsed />)
    expect(screen.getByRole('columnheader', { name: '事件' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Tokens' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: '耗时' })).toBeNull()
    expect(screen.getByText('3 条记录已收起')).toBeTruthy()
    expect(screen.queryByRole('row', { name: /记录 1，ASSISTANT/ })).toBeNull()
  })
})
