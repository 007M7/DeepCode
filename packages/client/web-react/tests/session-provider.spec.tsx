// @vitest-environment jsdom
import { useEffect, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { RootBinding } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSessionProvider, createSnapshotStore, RootBindingProvider,
  useRootBinding, useSessionBinding,
  type SessionBinding, type SessionProviderDeps,
} from '@deepseek-ai/dsh-client-web-react'

const makeBinding = (sessionId: string): SessionBinding => ({
  sessionId,
  session: { useSelector: (() => { throw new Error('unused') }) as never },
  ctx: { tag: sessionId },
})

function setup(bindings: Record<string, SessionBinding>) {
  const current = createSnapshotStore<{ id: string | undefined }>({ id: undefined })
  const resolveBinding = vi.fn((id: string) => bindings[id])
  const seen: { id: string; binding: SessionBinding; mountCount: number }[] = []
  let mounts = 0

  function Body({ id }: { id: string }) {
    const binding = useSessionBinding()
    const mountRef = useRef(0)
    useEffect(() => { mounts += 1; mountRef.current = mounts }, [])
    seen.push({ id, binding, mountCount: mountRef.current })
    return <div data-testid="body">{id}</div>
  }

  const deps: SessionProviderDeps = {
    useCurrent: () => current.useSelector((s) => s.id),
    resolveBinding,
    renderBody: (id) => <Body id={id} />,
  }
  const SessionProvider = createSessionProvider(deps)
  return { current, resolveBinding, SessionProvider, seen, mountCount: () => mounts }
}

describe('createSessionProvider', () => {
  it('renders empty without a current session and switches to the body on select', () => {
    const { current, SessionProvider } = setup({ s1: makeBinding('s1') })
    const view = render(<SessionProvider renderEmpty={() => <span>empty</span>} />)
    expect(view.container.textContent).toBe('empty')
    act(() => { current.update((d) => { d.id = 's1' }) })
    expect(view.container.textContent).toBe('s1')
  })

  it('renders null empty state when renderEmpty is omitted', () => {
    const { SessionProvider } = setup({})
    const view = render(<SessionProvider />)
    expect(view.container.textContent).toBe('')
  })

  it('falls back to empty when the binding does not resolve', () => {
    const { current, SessionProvider } = setup({})
    const view = render(<SessionProvider renderEmpty={() => <span>empty</span>} />)
    act(() => { current.update((d) => { d.id = 'ghost' }) })
    expect(view.container.textContent).toBe('empty')
  })

  it('passes the resolved binding through context and remounts on session switch', () => {
    const bindings = { s1: makeBinding('s1'), s2: makeBinding('s2') }
    const { current, SessionProvider, seen, mountCount } = setup(bindings)
    render(<SessionProvider />)
    act(() => { current.update((d) => { d.id = 's1' }) })
    expect(seen.at(-1)!.binding).toBe(bindings.s1)
    const mountsAfterS1 = mountCount()
    act(() => { current.update((d) => { d.id = 's2' }) })
    expect(seen.at(-1)!.binding).toBe(bindings.s2)
    // key={id} semantics: switching sessions remounts the body subtree.
    expect(mountCount()).toBe(mountsAfterS1 + 1)
  })

  it('does not remount the body when unrelated renders happen on the same session', () => {
    const bindings = { s1: makeBinding('s1') }
    const { current, SessionProvider, mountCount } = setup(bindings)
    const view = render(<SessionProvider />)
    act(() => { current.update((d) => { d.id = 's1' }) })
    const mounts = mountCount()
    view.rerender(<SessionProvider />)
    expect(mountCount()).toBe(mounts)
  })
})

describe('binding contexts', () => {
  it('useSessionBinding throws outside a SessionProvider subtree', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Naked() { useSessionBinding(); return null }
    expect(() => render(<Naked />)).toThrow(/outside SessionProvider/)
    spy.mockRestore()
  })

  it('RootBindingProvider supplies the root binding; absence throws', () => {
    const root: RootBinding = { ctx: { tag: 'root' } }
    let got: RootBinding | undefined
    function Probe() { got = useRootBinding(); return null }
    render(<RootBindingProvider value={root}><Probe /></RootBindingProvider>)
    expect(got).toBe(root)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/RootBindingProvider/)
    spy.mockRestore()
  })
})
