// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

afterEach(cleanup)
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { classifyTool, resolveToolPath, toolRowModel } from '../src/client/contract/tool-call-model.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { ToolRow } from '../src/client/chat/ToolRow.tsx'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/chat/GenericToolCard.tsx'
import { zh } from '../src/client/locales.ts'

// Mirrors the real lookup chain (conversation namespace, then common).
const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}',
  turn: 1, step: 1, time: 1_000, callView: null, ...over,
})

const result = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' },
  callTime: 1_000,
  content: [], isError: false, callView: null, resultView: null, ...over,
})

describe('tool-call-model', () => {
  it('classifies known tools and falls back to others', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('read')).toBe('read')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('write')).toBe('write')
    expect(classifyTool('edit')).toBe('edit')
    expect(classifyTool('cordis_inspect')).toBe('read')
    expect(classifyTool('cordis_mount')).toBe('code')
    expect(classifyTool('cordis_unmount')).toBe('others')
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
    expect(toolRowModel('write', running({ name: 'write', argsRaw: '{"file_path":"src/x.ts"}' })).summary).toBe('src/x.ts')
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"src/x.ts"}' })).summary).toBe('src/x.ts')
    // Others rows prefix the real tool name into the summary slot (figma-flows
    // ruling: static "Tool call" title, name rides the mutable summary).
    expect(toolRowModel('x', running({ argsRaw: '{"n":1}' })).summary).toBe('x · {"n":1}')
    expect(toolRowModel('x', running({ argsRaw: 'not json' })).summary).toBe('x · not json')
    expect(toolRowModel('x', running({ argsRaw: '' })).summary).toBe('x · c1')
    expect(toolRowModel('', running({ argsRaw: '' })).summary).toBe('c1')
  })

  it('exposes filePath for path/file_path args and skips URL-only reads', () => {
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('write', running({ name: 'write', argsRaw: '{"file_path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"src/a.ts"}' })).filePath).toBe('src/a.ts')
    expect(toolRowModel('web_fetch', running({ name: 'web_fetch', argsRaw: '{"url":"https://example.com"}' })).filePath)
      .toBeUndefined()
    expect(toolRowModel('bash', running()).filePath).toBeUndefined()
  })

  it('resolveToolPath joins relative paths under cwd and passes absolute through', () => {
    expect(resolveToolPath('/w', 'src/a.ts')).toBe('/w/src/a.ts')
    expect(resolveToolPath('/w/', '/abs/a.ts')).toBe('/abs/a.ts')
    expect(resolveToolPath(undefined, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveToolPath('/w', 'C:\\x\\a.ts')).toBe('C:\\x\\a.ts')
  })

  it('displays workspace-rooted paths relative to the session cwd', () => {
    const cwd = '/Users/u/ws/'
    expect(toolRowModel('edit', running({ name: 'edit', argsRaw: '{"file_path":"/Users/u/ws/src/x.ts"}' }), cwd).summary).toBe('src/x.ts')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/ws/a.md"}' }), cwd).summary).toBe('a.md')
    // Paths outside the workspace (and non-path summaries) stay verbatim.
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/etc/hosts"}' }), cwd).summary).toBe('/etc/hosts')
    expect(toolRowModel('bash', running({ argsRaw: '{"command":"pwd"}' }), cwd).summary).toBe('pwd')
    expect(toolRowModel('read', running({ name: 'read', argsRaw: '{"path":"/Users/u/ws/a.md"}' }), '').summary).toBe('/Users/u/ws/a.md')
  })

  it('body pretty-prints JSON args, keeps raw non-JSON, null when empty', () => {
    expect(toolRowModel('bash', running({ argsRaw: '{"a":1}' })).body).toBe('{\n  "a": 1\n}')
    expect(toolRowModel('bash', running({ argsRaw: 'raw' })).body).toBe('raw')
    expect(toolRowModel('bash', running({ argsRaw: '' })).body).toBeNull()
    expect(toolRowModel('bash', result({ call: null })).body).toBeNull()
  })

  it('a code row with an empty program falls back to the args JSON envelope', () => {
    expect(toolRowModel('run_code', running({ name: 'run_code', argsRaw: '{"code":""}' })).body)
      .toBe('{\n  "code": ""\n}')
  })

  it('gives Cordis lifecycle tools action titles over their generic variants', () => {
    expect(toolRowModel('cordis_inspect', running({
      name: 'cordis_inspect',
      argsRaw: '{"what":"api","name":"tools"}',
    }))).toMatchObject({
      variant: 'read',
      title: 'Inspect',
      summary: 'api',
    })
    expect(toolRowModel('cordis_mount', running({
      name: 'cordis_mount',
      argsRaw: '{"code":"return { name: \\"audit\\", apply(ctx) {} }"}',
    }))).toMatchObject({
      variant: 'code',
      title: 'Mount temporary Plugin',
      summary: 'return { name: "audit", apply(ctx) {} }',
      body: 'return { name: "audit", apply(ctx) {} }',
    })
    expect(toolRowModel('cordis_unmount', result({
      call: { name: 'cordis_unmount', argsRaw: '{"id":"dyn-2"}' },
    }))).toMatchObject({
      variant: 'others',
      title: 'Unmount temporary Plugin',
      summary: 'dyn-2',
    })
  })
})

describe('ToolRow', () => {
  const rowProps = {
    t,
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

  it('running keeps the icon (row sweep carries the signal); error swaps in a StateDot', () => {
    const runningView = render(<ToolRow {...rowProps} state="running" />)
    expect(runningView.queryByTestId('tool-icon')).not.toBeNull()
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    const errorView = render(<ToolRow {...rowProps} state="error" />)
    expect(errorView.container.querySelector('[data-testid="tool-icon"]')).toBeNull()
  })

  it('non-expandable rows render a passive leading slot', () => {
    const view = render(<ToolRow {...rowProps} body={null} />)
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.queryByTestId('tool-icon')).not.toBeNull()
  })

  it('an expandOnRowClick row toggles from Enter and Space, ignoring other keys', () => {
    const view = render(<ToolRow {...rowProps} expandOnRowClick />)
    const row = view.getByRole('button')
    fireEvent.keyDown(row, { key: 'Tab' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('a non-expandable expandOnRowClick row exposes no row button', () => {
    const view = render(<ToolRow {...rowProps} body={null} expandOnRowClick />)
    expect(view.queryByRole('button')).toBeNull()
  })

  it('file-path summary opens through onOpenFile; the leading slot is not an expand control', () => {
    const open = vi.fn()
    const view = render(
      <ToolRow {...rowProps} variant="read" title="Read" summary="src/a.ts" filePath="src/a.ts" onOpenFile={open} />,
    )
    fireEvent.click(view.getByText('src/a.ts'))
    expect(open).toHaveBeenCalledWith('src/a.ts')
    // Only the path link is a button — no args-expand affordance on file rows.
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    expect(view.queryByText(/"a": 1/)).toBeNull()
  })

  it('a single-file path disables expand even when onOpenFile is absent', () => {
    const view = render(
      <ToolRow {...rowProps} variant="write" title="Write" summary="作文.md" filePath="作文.md" />,
    )
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    fireEvent.click(view.getByText('作文.md'))
    expect(view.queryByText(/"a": 1/)).toBeNull()
  })

  it('non-file rows do not open anything when the summary is clicked', () => {
    const open = vi.fn()
    const view = render(<ToolRow {...rowProps} onOpenFile={open} />)
    fireEvent.click(view.getByText('List files'))
    expect(open).not.toHaveBeenCalled()
  })
})

describe('ThinkRow', () => {
  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('Inspect the session'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('Think'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('GenericToolCard', () => {
  const props = (toolName: string, block: RunningToolCall | ToolResultNode): GenericToolCardProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(), t,
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

  it('renders edit with its dedicated title, icon variant, and path summary', () => {
    const view = render(
      <GenericToolCard {...props('edit', running({
        name: 'edit',
        argsRaw: '{"file_path":"src/x.ts","old_string":"before","new_string":"after"}',
      }))} />,
    )
    expect(view.getByText('Edit')).toBeTruthy()
    expect(view.getByText('src/x.ts')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="edit"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('renders write with its dedicated title, icon variant, and path summary', () => {
    const view = render(
      <GenericToolCard {...props('write', running({
        name: 'write',
        argsRaw: '{"file_path":"src/x.ts","content":"hello"}',
      }))} />,
    )
    expect(view.getByText('Write')).toBeTruthy()
    expect(view.getByText('src/x.ts')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="write"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('file-path summary click reaches openFile; bash summary does not', () => {
    const file = props('read', running({ name: 'read', argsRaw: '{"path":"src/x.ts"}' }))
    const fileView = render(<GenericToolCard {...file} />)
    fireEvent.click(fileView.getByText('src/x.ts'))
    expect(file.openFile).toHaveBeenCalledWith('src/x.ts')

    const bash = props('bash', result())
    const bashView = render(<GenericToolCard {...bash} />)
    fireEvent.click(bashView.getByText('List files'))
    expect(bash.openFile).not.toHaveBeenCalled()
  })
})
