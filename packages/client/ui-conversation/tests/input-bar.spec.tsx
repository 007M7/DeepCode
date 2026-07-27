// @vitest-environment jsdom
// InputBar behavior over the machine wiring: Enter-send semantics (IME guard,
// shift newline, ctrl/meta insert, repeat suppression), queue-cut-1 running
// semantics (input stays free; primary turns stop), the machine pending lock,
// decoration backdrop, error/notice strips, and the focus-keeping mousedown.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'

afterEach(cleanup)

const SCTX = {} as ClientContext
const SID = 's1' as SessionId

function snapshotOf(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, nodes: [], foldDegraded: false, partial: null, runningCalls: [], codeDispatches: new Map(),
    pending: [], queue: [], todos: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, lastAgentError: null,
    ...overrides,
  }
}

interface BenchOptions {
  planEntry?: React.ReactNode
  modelEntry?: React.ReactNode
  /** Hot text-ref lexicon (injects a minimal slash stub exposing only lexicon()). */
  lexicon?: ReadonlyMap<'/' | '@', readonly string[]>
  draft?: string
  running?: boolean
  disabled?: boolean
  promptError?: ConversationSnapshot['promptError']
  variant?: 'hero' | 'composer'
  placeholder?: string
  accessory?: React.ReactNode
  overlay?: React.ReactNode
  leftItems?: React.ReactNode
  rightItems?: React.ReactNode
}

/** Real machine behind the bar entry: sink spy, no slash pipeline (plain text goes straight to the sink). */
function bench(over?: BenchOptions) {
  const sink = vi.fn()
  const lex = over?.lexicon
  type ShellDeps = ConstructorParameters<typeof SessionInputShell>[0]
  const shell = new SessionInputShell({
    actx: SCTX,
    defaultSink: sink,
    // Lexicon-only stub: adjudication untouched (undefined slash methods are
    // never reached — these benches drive plain-draft flows only).
    ...(lex !== undefined
      ? { slash: (() => ({ lexicon: () => lex })) as unknown as NonNullable<ShellDeps['slash']> }
      : {}),
  })
  if (over?.draft !== undefined && over.draft !== '') shell.setDraft(over.draft)
  const session = createSnapshotStore<ConversationSnapshot>(snapshotOf({
    running: over?.running ?? false,
    removed: over?.disabled ?? false,
    promptError: over?.promptError ?? null,
  }))
  const stop = vi.fn()
  const slotCalls: { key: string; owner: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, owner })
    if (key === 'conversation.input.plan') return over?.planEntry ?? null
    if (key === 'conversation.input.model') return over?.modelEntry ?? null
    return null
  }) as InputBarProps['renderSlot']
  const props: InputBarProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children(SID),
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
    })) as InputBarProps['useSessions'],
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })) as InputBarProps['useWorkspaces'],
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    stop,
    renderSlot,
    variant: over?.variant ?? 'composer',
    ...(over?.placeholder !== undefined ? { placeholder: over.placeholder } : {}),
    ...(over?.accessory !== undefined ? { accessory: over.accessory } : {}),
    ...(over?.overlay !== undefined ? { overlay: over.overlay } : {}),
    ...(over?.leftItems !== undefined ? { leftItems: over.leftItems } : {}),
    ...(over?.rightItems !== undefined ? { rightItems: over.rightItems } : {}),
  }
  const view = render(<InputBar {...props} />)
  const textarea = view.container.querySelector('textarea')!
  // aria-label (not role name): title carries the same label and would double-match.
  const button = view.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${over?.running === true ? 'Stop generating' : 'Send message'}"]`,
  )!
  return { view, textarea, button, props, sink, shell, wiring: shell, session, stop, slotCalls }
}

describe('Enter semantics', () => {
  it('plain Enter submits queue mode through the machine; repeat and empty are suppressed', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('hello', 'queue')
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true })
    expect(sink).toHaveBeenCalledTimes(1)
    const empty = bench({ draft: '   ' })
    fireEvent.keyDown(empty.textarea, { key: 'Enter' })
    expect(empty.sink).not.toHaveBeenCalled()
  })

  it('non-Enter keys and Shift+Enter fall through to native behavior', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'a' })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled()
  })

  it('Shift+Enter newline wins even inside IME composition (unconditional precedence)', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled() // and not preventDefault'd: native newline
  })

  it('Ctrl/Meta+Enter inserts a newline through the machine (no browser execCommand)', () => {
    const { textarea, shell, sink } = bench({ draft: 'hello' })
    textarea.setSelectionRange(5, 5)
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(shell.snapshot.draft).toBe('hello\n')
    expect(sink).not.toHaveBeenCalled()
  })

  it('platform undo/redo chords route to the machine, never the browser stack', () => {
    const { textarea, shell } = bench({ draft: '' })
    fireEvent.change(textarea, { target: { value: 'first' } })
    fireEvent.change(textarea, { target: { value: 'first second' } })
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    expect(shell.snapshot.draft).not.toBe('first second')
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(shell.snapshot.draft).toBe('first second')
  })

  it('composition Enter never sends: ref guard, isComposing, and keyCode 229 paths', () => {
    vi.useFakeTimers()
    try {
      const { textarea, sink } = bench({ draft: 'hello' })
      fireEvent.compositionStart(textarea)
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.compositionEnd(textarea)
      // Safari delivers the closing keydown before the deferred clear.
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running and lock semantics (queue cut 1)', () => {
  it('running keeps the input free (typing + Enter queue) while the primary turns stop', () => {
    const { textarea, button, stop, sink } = bench({ running: true, draft: '排队消息' })
    expect(textarea.disabled).toBe(false) // running no longer locks
    fireEvent.change(textarea, { target: { value: '排队消息2' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('排队消息2', 'queue')
    expect(button.getAttribute('aria-label')).toBe('Stop generating')
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('disabled (session removed) locks the textarea and chrome', () => {
    const { textarea, view } = bench({ disabled: true })
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session unavailable')
    expect((view.getByLabelText('Add attachment') as HTMLButtonElement).disabled).toBe(true)
  })

  it('idle primary sends and disables on empty draft', () => {
    const { button, sink } = bench({ draft: 'go' })
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('go', 'queue')
    const empty = bench()
    expect(empty.button.disabled).toBe(true)
  })

  it('unlock refocuses the textarea; mousedown on the button keeps focus', () => {
    const first = bench({ disabled: true, draft: 'x' })
    act(() => { first.session.set(snapshotOf({ removed: false })) })
    const textarea = first.view.container.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    textarea.blur()
    fireEvent.mouseDown(first.view.container.querySelector('button[aria-label="Send message"]')!)
    expect(document.activeElement).toBe(textarea)
  })

  it('typing forwards through the machine (draft state echoes back)', () => {
    const { textarea, wiring } = bench()
    fireEvent.change(textarea, { target: { value: 'typed' } })
    expect(wiring.state.getSnapshot().draft).toBe('typed')
    expect((textarea as HTMLTextAreaElement).value).toBe('typed')
  })

  it('disabled state shows the unavailable placeholder; custom placeholder wins', () => {
    const { textarea } = bench({ disabled: true })
    expect(textarea.placeholder).toBe('Session unavailable')
    const live = bench()
    expect(live.textarea.placeholder).toBe('Message the agent')
    const custom = bench({ placeholder: 'Custom placeholder' })
    expect(custom.textarea.placeholder).toBe('Custom placeholder')
  })
})

describe('machine pending lock', () => {
  it('submitting renders read-only textarea, pending dot, and a disabled primary', () => {
    const { view, shell } = bench()
    // Drive the machine into submitting through a claim + enter.
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        {
          token: '/goal ',
          submit: () => new Promise<never>(() => {}), // never settles: stays submitting
        },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
      shell.submit('queue')
    })
    expect(shell.snapshot.phase).toBe('submitting')
    const textarea = view.container.querySelector('textarea')!
    expect(textarea.readOnly).toBe(true)
    expect(view.container.querySelector('[data-input-pending]')).not.toBeNull()
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true)
  })
})

describe('decorations', () => {
  it('claimed token renders the mirror highlight and the blank-args hint', () => {
    const { view, shell } = bench()
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        { token: '/goal ', hint: '目标内容', submit: () => Promise.resolve({ kind: 'success' as const }) },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    const token = view.container.querySelector('[data-decoration="token"]')
    expect(token?.textContent).toBe('/goal ')
    expect(view.container.querySelector('[data-decoration="hint"]')?.textContent).toBe('目标内容')
    // Args typed: the hint disappears, the token highlight stays.
    act(() => { shell.setDraft('/goal 发布') })
    expect(view.container.querySelector('[data-decoration="hint"]')).toBeNull()
    expect(view.container.querySelector('[data-decoration="token"]')).not.toBeNull()
  })

  it('an inserted reference renders as a chip at its placeholder offset', () => {
    const { view, shell } = bench()
    act(() => {
      shell.setDraft('参考 @w1 内容')
      shell.insertReference(
        { source: 'subagent', ref: 'w1', label: '@w1', clipboardText: '@w1' },
        { start: 3, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    const chip = view.container.querySelector('[data-decoration="chip"]')
    expect(chip?.textContent).toBe('@w1')
    expect(shell.snapshot.occurrences).toHaveLength(1)
    // The draft carries exactly one placeholder char where the token was.
    expect(shell.snapshot.draft).toBe('参考 \uFFFC 内容')
  })

  it('a lexicon-matched plain token renders the text-ref mark (decision 21)', () => {
    const lexicon = new Map<'/' | '@', readonly string[]>([['/', ['fixture-demo']]])
    const { view, shell } = bench({ lexicon })
    act(() => { shell.setDraft('use /fixture-demo now') })
    const mark = view.container.querySelector('[data-decoration="text-ref"]')
    expect(mark?.textContent).toBe('/fixture-demo')
    // Editing the token out of match shape drops the decoration.
    act(() => { shell.setDraft('use /fixture-dem now') })
    expect(view.container.querySelector('[data-decoration="text-ref"]')).toBeNull()
  })
})

describe('insertText (decision 21 scoped event body)', () => {
  it('splices plain text over the span and reports success as true', () => {
    const { shell } = bench({ draft: '/fix' })
    const ok = shell.insertText('/fixture-demo ', { start: 0, end: 4, draftRev: shell.snapshot.draftRev })
    expect(ok).toBe(true)
    expect(shell.snapshot.draft).toBe('/fixture-demo ')
    expect(shell.snapshot.occurrences).toEqual([])
  })

  it('a stale draftRev refuses whole: false, draft untouched', () => {
    const { shell } = bench({ draft: '/fix' })
    const span = { start: 0, end: 4, draftRev: shell.snapshot.draftRev }
    act(() => { shell.setDraft('/fixX') })
    expect(shell.insertText('/fixture-demo ', span)).toBe(false)
    expect(shell.snapshot.draft).toBe('/fixX')
  })
})

describe('strips and variants', () => {
  it('derives the failure strip from promptError (ordinary failure — no transaction UI, no Retry)', () => {
    const send = bench({ promptError: { op: 'send', error: { code: 'agent-busy', message: 'boom', details: { reason: 'boom' } } } })
    expect(send.view.container.querySelector('[role="alert"]')?.textContent).toBe('boom (agent-busy)')
    expect(send.view.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('renders the notice strip from the machine notice store', () => {
    const { view, shell } = bench()
    act(() => { shell.notify('error', '命令失败了') })
    expect(view.getByText('命令失败了')).toBeTruthy()
  })

  it('hero variant adds the hero class and accessory row renders', () => {
    const { view } = bench({ variant: 'hero', accessory: <i data-testid="acc" /> })
    expect(view.getByTestId('acc')).toBeTruthy()
    expect(view.container.querySelector('[class*="hero"]')).not.toBeNull()
  })

  it('renders overlay anchor and left/right slot items', () => {
    const { view } = bench({
      overlay: <i data-testid="ov" />,
      leftItems: <i data-testid="li" />,
      rightItems: <i data-testid="ri" />,
    })
    expect(view.getByTestId('ov')).toBeTruthy()
    expect(view.getByTestId('li')).toBeTruthy()
    expect(view.getByTestId('ri')).toBeTruthy()
  })
})

describe('placeholder chrome and control seats', () => {
  it('renders attach + Access placeholder; plan/model seats render EMPTY without entries (B ruling)', () => {
    const { view, slotCalls } = bench()
    expect(view.getByLabelText('Add attachment')).toBeTruthy()
    expect((view.getByLabelText('Access mode') as HTMLSelectElement).value).toBe('readonly')
    // Both seats dispatched, nothing rendered.
    expect(slotCalls.map(c => c.key)).toEqual(['conversation.input.plan', 'conversation.input.model'])
    expect(view.queryByLabelText('Plan mode')).toBeNull()
    expect(view.queryByLabelText('Model')).toBeNull()
  })

  it('a registered entry fills its seat and receives the locked owner prop', () => {
    const { view, slotCalls } = bench({
      disabled: true,
      planEntry: <i data-testid="plan-entry" />,
      modelEntry: <i data-testid="model-entry" />,
    })
    expect(view.getByTestId('plan-entry')).toBeTruthy()
    expect(view.getByTestId('model-entry')).toBeTruthy()
    // The bar hands its chrome disable state to the filling entry.
    expect(slotCalls.every(c => (c.owner as { locked: boolean }).locked === true)).toBe(true)
    cleanup()
    const live = bench({ running: true })
    expect(live.slotCalls.every(c => (c.owner as { locked: boolean }).locked === false)).toBe(true)
  })

  it('disabled locks the Access placeholder and attach control (running does not)', () => {
    const { view } = bench({ disabled: true })
    expect((view.getByLabelText('Add attachment') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText('Access mode') as HTMLSelectElement).disabled).toBe(true)
    cleanup()
    const live = bench({ running: true })
    expect((live.view.getByLabelText('Access mode') as HTMLSelectElement).disabled).toBe(false)
  })
})
