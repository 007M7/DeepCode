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
    fireEvent.click(screen.getByRole('button', { name: 'Request Timing' }))

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

  it('keeps long thinking collapsed until the user asks to render it', () => {
    const thinking = 'private chain '.repeat(1_000)
    const turns: readonly TrajectoryTurnModel[] = [{
      turn: 1,
      groups: [{
        title: 'Step 1',
        cells: [{
          index: 1,
          kind: 'message',
          text: 'private chain…',
          thinkingDetail: thinking,
          timeSeconds: 1,
        }],
      }],
    }]
    render(<TrajectoryTable turns={turns} {...FOLD_PROPS} />)

    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    const toggle = screen.getByRole('button', { name: 'Thinking' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(thinking)).toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Thinking' })).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.parentElement?.textContent?.length).toBeGreaterThan(thinking.length)
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

  it('follows appended records only while the ledger is already at the bottom', () => {
    const view = render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    const tablePane = screen.getByRole('table').parentElement as HTMLElement
    let scrollHeight = 200
    Object.defineProperties(tablePane, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    })
    tablePane.scrollTop = 100
    fireEvent.scroll(tablePane)

    scrollHeight = 260
    view.rerender(
      <TrajectoryTable
        turns={[...TURNS, {
          turn: 2,
          groups: [{
            title: 'Step 1',
            cells: [{ index: 4, kind: 'message', text: 'new reply', timeSeconds: 0.1 }],
          }],
        }]}
        {...FOLD_PROPS}
      />,
    )
    expect(tablePane.scrollTop).toBe(260)

    tablePane.scrollTop = 20
    fireEvent.scroll(tablePane)
    scrollHeight = 320
    view.rerender(
      <TrajectoryTable
        turns={[...TURNS, {
          turn: 2,
          groups: [{
            title: 'Step 1',
            cells: [
              { index: 4, kind: 'message', text: 'new reply', timeSeconds: 0.1 },
              { index: 5, kind: 'tool', text: 'new tool', timeSeconds: 0.1 },
            ],
          }],
        }]}
        {...FOLD_PROPS}
      />,
    )
    expect(tablePane.scrollTop).toBe(20)
  })

  it('keeps running and failure semantics distinct from record roles', () => {
    const view = render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    expect(view.container.querySelector('tr[data-kind="tool"][data-running="true"]')).toBeTruthy()
    expect(view.container.querySelector('tr[data-kind="tool"][data-error="true"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('row', { name: /TOOL, bash \{"command":"pwd"\}/ }))
    expect(screen.getByText('Pending')).toBeTruthy()
    fireEvent.click(screen.getByRole('row', { name: /TOOL, bash \{"command":"false"\}/ }))
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Failed').className).toContain('error')
    fireEvent.click(screen.getByRole('tab', { name: 'Result' }))
    const errorResult = screen.getByText('ToolError: non_zero_exit')
    expect(errorResult.closest('[class*="errorPayload"]')).toBeTruthy()
  })

  it('marks failed requests and lays coincident request markers left to right', () => {
    const turns: readonly TrajectoryTurnModel[] = [
      {
        turn: 1,
        groups: [{
          title: 'Step 1',
          cells: [{
            index: 1,
            kind: 'message',
            text: '',
            requestOnly: true,
            isError: true,
            timeSeconds: 0.1,
          }],
        }],
      },
      {
        turn: 2,
        groups: [{
          title: 'Step 1',
          cells: [{
            index: 2,
            kind: 'message',
            text: '',
            requestOnly: true,
            isError: true,
            timeSeconds: 0.1,
          }],
        }],
      },
      {
        turn: 3,
        groups: [{
          title: 'Step 1',
          cells: [{
            index: 3,
            kind: 'message',
            text: 'Recovered response',
            timeSeconds: 0.1,
          }],
        }],
      },
    ]
    render(<TrajectoryTable turns={turns} {...FOLD_PROPS} />)

    const failed = screen.getByRole('button', { name: 'Request #1' })
    const retry = screen.getByRole('button', { name: 'Request #2' })
    const recovered = screen.getByRole('button', { name: 'Request #3' })
    expect(failed.getAttribute('data-request-status')).toBe('error')
    expect(failed.getAttribute('data-request-run-index')).toBe('0')
    expect(failed.style.getPropertyValue('--request-boundary-offset')).toBe('0px')
    expect(retry.getAttribute('data-request-run-index')).toBe('1')
    expect(retry.style.getPropertyValue('--request-boundary-offset')).toBe('8px')
    expect(recovered.getAttribute('data-request-run-index')).toBe('2')
    expect(recovered.style.getPropertyValue('--request-boundary-offset')).toBe('16px')
  })

  it('shows the custom role tooltip only from the responsive icon', () => {
    const view = render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    const toolTag = view.container.querySelector<HTMLElement>('[data-role-kind="tool"]')
    const toolIcon = toolTag?.querySelector<HTMLElement>('[data-role-icon="wrench"]')

    expect(toolTag).not.toBeNull()
    expect(toolTag?.getAttribute('title')).toBeNull()
    expect(toolIcon).toBeTruthy()

    fireEvent.mouseEnter(toolTag as HTMLElement)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(toolIcon as HTMLElement)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('TOOL')
    expect(tooltip.getAttribute('data-side')).toBe('right')
    fireEvent.mouseLeave(toolIcon as HTMLElement)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('uses information and compression glyphs for injected and compacted context', () => {
    const turns: readonly TrajectoryTurnModel[] = [{
      turn: 1,
      groups: [{
        title: 'Context',
        cells: [
          { index: 1, kind: 'context', text: 'Workspace context', timeSeconds: 0 },
          { index: 2, kind: 'compacted', text: 'Compacted history', timeSeconds: 0 },
        ],
      }],
    }]
    const view = render(<TrajectoryTable turns={turns} {...FOLD_PROPS} />)

    expect(view.container.querySelector(
      '[data-role-kind="context"] [data-role-icon="information"]',
    )).toBeTruthy()
    expect(view.container.querySelector(
      '[data-role-kind="compacted"] [data-role-icon="compacted"]',
    )).toBeTruthy()
  })

  it('keeps a compact turn label available for narrow layouts', () => {
    render(<TrajectoryTable turns={TURNS} {...FOLD_PROPS} />)
    const turnLabel = screen.getByLabelText('Turn 1')

    expect(turnLabel.textContent).toContain('Turn 1')
    expect(turnLabel.textContent).toContain('#1')
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

  const CALL_TURNS: readonly TrajectoryTurnModel[] = [{
    turn: 1,
    groups: [{
      title: 'Step 1',
      cells: [{
        index: 1,
        kind: 'tool',
        text: 'bash · {"command":"pwd"}',
        inputDetail: '{"command":"pwd"}',
        callId: 'call-1',
        timeSeconds: 0.1,
      }],
    }],
  }]

  it('an inspect target opens the matching record and acknowledges once', () => {
    const onInspectApplied = vi.fn()
    render(
      <TrajectoryTable
        turns={CALL_TURNS}
        {...FOLD_PROPS}
        inspectCallId="call-1"
        onInspectApplied={onInspectApplied}
      />,
    )

    expect(screen.getByRole('row', { name: /TOOL/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Event details' })).toBeTruthy()
    expect(onInspectApplied).toHaveBeenCalledOnce()
  })

  it('an unmatched inspect target stays pending without acknowledgement', () => {
    const onInspectApplied = vi.fn()
    render(
      <TrajectoryTable
        turns={CALL_TURNS}
        {...FOLD_PROPS}
        inspectCallId="call-missing"
        onInspectApplied={onInspectApplied}
      />,
    )

    expect(screen.getByRole('row', { name: /TOOL/ }).getAttribute('aria-selected')).toBe('false')
    expect(onInspectApplied).not.toHaveBeenCalled()
  })
})
