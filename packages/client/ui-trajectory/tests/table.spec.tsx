// @vitest-environment jsdom
/** Trajectory ledger selection, details, status, and fold behavior. */

import { afterEach, describe, expect, it, vi } from 'vitest'
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

const FOLD_PROPS = {
  collapsedTurns: new Set<number>(),
  onToggleTurn: () => {},
  collapsedAssistants: new Set<number>(),
  onToggleAssistant: () => {},
}

describe('TrajectoryTable', () => {
  it('shows assistant timing facts after keyboard selection', () => {
    render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    fireEvent.keyDown(screen.getByRole('row', { name: /ASSISTANT/ }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Timing' }))

    expect(screen.getByText('500 ms')).toBeTruthy()
    expect(screen.getByText('1.00 s')).toBeTruthy()
    expect(screen.getByText('20.0 tok/s')).toBeTruthy()
  })

  it('breaks output tokens into labeled reasoning and content rows', () => {
    render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))

    expect(screen.getByText('Tokens')).toBeTruthy()
    expect(screen.getByText('20 tok')).toBeTruthy()
    expect(screen.getByText('Reasoning')).toBeTruthy()
    expect(screen.getByText('5 tok')).toBeTruthy()
    expect(screen.getByText('Content')).toBeTruthy()
    expect(screen.getByText('15 tok')).toBeTruthy()
  })

  it('keeps raw HTML tags in a Markdown-derived context preview', () => {
    const html = [
      '<background-task-complete id="trajectory-ui-watch">',
      'Command: pnpm test',
      'Exit code: 0',
      '</background-task-complete>',
    ].join('\n')
    const turns: readonly TrajectoryTurnModel[] = [{
      turn: 1,
      groups: [{
        title: 'Message',
        cells: [{
          index: 1,
          kind: 'context',
          text: '',
          inputDetail: html,
          timeSeconds: 0,
        }],
      }],
    }]

    render(<TrajectoryTable turns={turns} {...FOLD_PROPS} />)

    expect(screen.getByText(
      '<background-task-complete id="trajectory-ui-watch"> Command: pnpm test Exit code: 0 </background-task-complete>',
    )).toBeTruthy()
  })

  it('clears the selected row when ledger whitespace is clicked', () => {
    const onClearSelection = vi.fn()
    render(
      <TrajectoryTable
        turns={TURNS}
        {...FOLD_PROPS}
        onClearSelection={onClearSelection}
      />,
    )
    const row = screen.getByRole('row', { name: /ASSISTANT/ })
    fireEvent.click(row)

    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Event details' })).toBeTruthy()

    const tablePane = screen.getByRole('table').parentElement
    expect(tablePane).not.toBeNull()
    fireEvent.click(tablePane as HTMLElement)

    expect(row.getAttribute('aria-selected')).toBe('false')
    expect(screen.queryByRole('complementary', { name: 'Event details' })).toBeNull()
    expect(onClearSelection).toHaveBeenCalledOnce()
  })

  it('keeps running and failure semantics distinct from record roles', () => {
    const view = render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    expect(view.container.querySelector('tr[data-kind="tool"][data-running="true"]')).toBeTruthy()
    expect(view.container.querySelector('tr[data-kind="tool"][data-error="true"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('row', { name: /TOOL, bash \{"command":"pwd"\}/ }))
    expect(screen.getByText('Pending')).toBeTruthy()
    fireEvent.click(screen.getByRole('row', { name: /TOOL, bash \{"command":"false"\}/ }))
    expect(screen.getByText('Failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Result' }))
    expect(screen.getByText('ToolError: non_zero_exit')).toBeTruthy()
  })

  it('renders a single-text JSON tool result as a JSON tree', () => {
    const turns: readonly TrajectoryTurnModel[] = [{
      turn: 1,
      groups: [{
        title: 'Step 1',
        cells: [{
          index: 1,
          kind: 'tool',
          text: 'read {"path":"result.json"}',
          outputDetail: '{"value":1,"nested":{"ok":true}}',
          outputBlocks: [{
            type: 'text',
            content: '{"value":1,"nested":{"ok":true}}',
          }],
          timeSeconds: 0.1,
        }],
      }],
    }]

    render(<TrajectoryTable turns={turns} {...FOLD_PROPS} />)
    fireEvent.click(screen.getByRole('row', { name: /TOOL/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Result' }))

    expect(screen.getByRole('tree', { name: 'Result JSON' })).toBeTruthy()
    expect(screen.getByText('value:')).toBeTruthy()
  })

  it('keeps the first row and a compact summary when a turn is collapsed', () => {
    render(
      <TrajectoryTable
        turns={TURNS}
        {...FOLD_PROPS}
        collapsedTurns={new Set([1])}
      />,
    )
    expect(screen.queryByRole('columnheader')).toBeNull()
    expect(screen.getByRole('row', { name: /ASSISTANT/ })).toBeTruthy()
    expect(screen.getByRole('row', { name: /Collapsed turn summary/ })).toBeTruthy()
  })
})
