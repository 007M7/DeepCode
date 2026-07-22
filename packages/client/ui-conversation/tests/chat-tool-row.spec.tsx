// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

afterEach(cleanup)
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { UseSession } from '@deepseek-ai/dsh-client-ui-slots'
import { classifyTool, toolRowModel } from '../src/client/contract/tool-call-model.ts'
import { ToolRow } from '../src/client/chat/ToolRow.tsx'
import { GenericToolCard } from '../src/client/chat/GenericToolCard.tsx'
import type { ToolViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}',
  turn: 1, step: 1, callView: null, ...over,
})

const result = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, callId: 'c1',
  call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' },
  content: [], isError: false, callView: null, resultView: null, ...over,
})

describe('tool-call-model', () => {
  it('classifies known tools and falls back to others', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('read')).toBe('read')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('todo_write')).toBe('others')
  })

  it('derives state across running/ok/error/interrupted', () => {
    expect(toolRowModel('bash', running()).state).toBe('running')
    expect(toolRowModel('bash', result()).state).toBe('ok')
    expect(toolRowModel('bash', result({ isError: true })).state).toBe('error')
    expect(toolRowModel('bash', result({ isError: true, error: { name: 'E', code: 'interrupted' } })).state).toBe('stopped')
  })

  it('derives the bash summary from description over command', () => {
    const m = toolRowModel('bash', running())
    expect(m.title).toBe('Bash')
    expect(m.summary).toBe('List files')
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"pwd"}' })).summary).toBe('pwd')
  })

  it('keeps summaries single-line and falls back for opaque args', () => {
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"a\\nb"}' })).summary).toBe('a')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/tmp/x.ts"}' })).summary).toBe('/tmp/x.ts')
    // Others rows prefix the real tool name into the summary slot (figma-flows
    // ruling: static "Tool call" title, name rides the mutable summary).
    expect(toolRowModel('x', running({ argsRaw: '{"n":1}' })).summary).toBe('x · {"n":1}')
    expect(toolRowModel('x', running({ argsRaw: 'not json' })).summary).toBe('x · not json')
    expect(toolRowModel('x', running({ argsRaw: '' })).summary).toBe('x · c1')
    expect(toolRowModel('', running({ argsRaw: '' })).summary).toBe('c1')
  })

  it('body pretty-prints JSON args, keeps raw non-JSON, null when empty', () => {
    expect(toolRowModel('bash', running({ argsRaw: '{"a":1}' })).body).toBe('{\n  "a": 1\n}')
    expect(toolRowModel('bash', running({ argsRaw: 'raw' })).body).toBe('raw')
    expect(toolRowModel('bash', running({ argsRaw: '' })).body).toBeNull()
    expect(toolRowModel('bash', result({ call: null })).body).toBeNull()
  })
})

describe('ToolRow', () => {
  const rowProps = {
    variant: 'bash' as const, icon: <i data-testid="tool-icon" />, title: 'Bash',
    summary: 'List files', body: '{\n  "a": 1\n}', state: 'ok' as const,
  }

  it('renders leading icon, title and summary while collapsed', () => {
    const view = render(<ToolRow {...rowProps} />)
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('expanding swaps the leading slot to a chevron, hides summary, shows body', () => {
    const view = render(<ToolRow {...rowProps} />)
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.queryByTestId('tool-icon')).toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.queryByText('List files')).toBeNull()
    expect(view.getByText(/"a": 1/)).toBeTruthy()
    fireEvent.click(view.container.querySelector('button')!)
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
    expect(view.getByText('List files')).toBeTruthy()
  })

  it('running and error states replace the icon with a StateDot', () => {
    const runningView = render(<ToolRow {...rowProps} state="running" />)
    expect(runningView.queryByTestId('tool-icon')).toBeNull()
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    const errorView = render(<ToolRow {...rowProps} state="error" />)
    expect(errorView.queryByTestId('tool-icon')).toBeNull()
  })

  it('non-expandable rows render a passive leading slot', () => {
    const view = render(<ToolRow {...rowProps} body={null} />)
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
  })

  it('row click hands off to onOpenDetails; the expand toggle does not', () => {
    const open = vi.fn()
    const view = render(<ToolRow {...rowProps} onOpenDetails={open} />)
    fireEvent.click(view.getByText('List files'))
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(view.container.querySelector('button')!)
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('GenericToolCard', () => {
  const props = (toolName: string, block: RunningToolCall | ToolResultNode): ToolViewProps => ({
    callId: 'c1', toolName, block,
    useSession: (() => { throw new Error('unused') }) as unknown as UseSession,
    actions: { openDetails: vi.fn() },
    t: (k) => k,
  })

  it('renders the classified variant row from the frozen slice', () => {
    const view = render(<GenericToolCard {...props('bash', result())} />)
    expect(view.getByText('Bash')).toBeTruthy()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="bash"]')).not.toBeNull()
  })

  it('unknown tools land on the others variant titled Tool call', () => {
    const view = render(
      <GenericToolCard {...props('todo_write', running({ name: 'todo_write', argsRaw: '{"note":"x"}' }))} />,
    )
    expect(view.getByText('Tool call')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('row click reaches actions.openDetails', () => {
    const p = props('bash', result())
    const view = render(<GenericToolCard {...p} />)
    fireEvent.click(view.getByText('List files'))
    expect(p.actions.openDetails).toHaveBeenCalledTimes(1)
  })
})
