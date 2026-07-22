// @vitest-environment jsdom
/**
 * AppRoot boot-gate smoke: loading page until the settled signal flips (status
 * alone never opens the gate), fail-loud plugin list, one-pass switch to the
 * real UI. The full browser chain (real loader + bundles) is the e2e's job;
 * this pins the shell-owned gate semantics.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

afterEach(cleanup)
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-web-react'
import type { LoaderStatus } from '@deepseek-ai/dsh-client-runtime/client'
import { AppRoot } from '@deepseek-ai/dsh-client-web/src/AppRoot.tsx'

function signal(): ObservableSnapshot<boolean> & { flip: () => void } {
  let value = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    flip: () => { value = true; for (const fn of [...listeners]) fn() },
  }
}

function mount() {
  const settled = signal()
  const status = createSnapshotStore<LoaderStatus>({})
  let renders = 0
  const utils = render(
    <AppRoot
      settled={settled}
      status={status}
      renderApp={() => { renders += 1; return <div data-testid="real-ui" /> }}
    />,
  )
  return { settled, status, counts: () => renders, ...utils }
}

describe('AppRoot', () => {
  it('shows the loading page and never calls renderApp before settled', () => {
    const { queryByTestId, counts, getByText } = mount()
    expect(getByText('HARNESS')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
    expect(counts()).toBe(0)
  })

  it('all-active status alone does not open the gate (settled signal is the only key)', () => {
    const { status, queryByTestId } = mount()
    act(() => {
      status.update((d) => { d['a'] = 'active'; d['b'] = 'active' })
    })
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('lists failed plugins and stays on the loading page', () => {
    const { status, getByText, queryByTestId } = mount()
    act(() => {
      status.update((d) => { d['@deepseek-ai/dsh-client-ui-theme'] = 'failed'; d['ok'] = 'active' })
    })
    expect(getByText('Failed to load plugins')).toBeTruthy()
    expect(getByText('@deepseek-ai/dsh-client-ui-theme')).toBeTruthy()
    expect(queryByTestId('real-ui')).toBeNull()
  })

  it('flipping settled switches to the real UI in one pass', () => {
    const { settled, getByTestId, queryByText, counts } = mount()
    act(() => { settled.flip() })
    expect(getByTestId('real-ui')).toBeTruthy()
    expect(queryByText('HARNESS')).toBeNull()
    expect(counts()).toBe(1)
  })
})
