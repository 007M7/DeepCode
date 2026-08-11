// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginSettingsSection } from '../src/client/PluginSettingsSection.tsx'
import type {
  PluginSettingsSectionInjected,
  PluginSettingsSectionProps,
} from '../src/client/PluginSettingsSection.tsx'
import { en, type PluginsKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PluginSettingsSectionInjected['list']>>
const t = ((key: PluginsKey): string => en[key]) as PluginSettingsSectionProps['t']
const unusedHook = (() => { throw new Error('unused by plugin inventory') }) as never

function props(list: PluginSettingsSectionInjected['list']): PluginSettingsSectionProps {
  return {
    close: vi.fn(),
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    t,
    list,
  }
}

const SNAPSHOT = {
  entries: [
    { entryId: 'active', displayId: 'active-name', enabled: true, fiberPhase: 'active' },
    { entryId: 'pending', displayId: 'pending-name', enabled: true, fiberPhase: 'pending' },
    { entryId: 'loading', displayId: 'loading-name', enabled: true, fiberPhase: 'loading' },
    { entryId: 'failed', displayId: 'failed-name', enabled: true, fiberPhase: 'failed' },
    { entryId: 'unloading', displayId: 'unloading-name', enabled: true, fiberPhase: 'unloading' },
    { entryId: 'disabled-entry', displayId: 'disabled-name', enabled: false, fiberPhase: null },
  ],
} as unknown as Snapshot

describe('PluginSettingsSection', () => {
  it('renders searchable two-column-card semantics with dots and tags', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const list = vi.fn(() => deferred.promise)
    const view = render(<PluginSettingsSection {...props(list)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => { deferred.resolve(SNAPSHOT) })
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByRole('searchbox', { name: en.search })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(view.container.querySelector('[data-plugin-count]')?.textContent).toBe('6')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(5)
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    for (const value of ['Active', 'Pending', 'Loading', 'Failed', 'Unloading', 'No root Fiber']) {
      expect(screen.getByRole('img', { name: value })).toBeTruthy()
    }
    expect(screen.getByRole('listitem', { name: 'active-name, Active, Enabled' })).toBeTruthy()
  })

  it('filters by local id or Loader entry id', async () => {
    render(<PluginSettingsSection {...props(async () => SNAPSHOT)} />)
    const search = await screen.findByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'disabled-entry' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('disabled-name')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'pending' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('pending-name')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginSettingsSectionInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginSettingsSection {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginSettingsSectionInjected['list']
    const failed = render(<PluginSettingsSection {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginSettingsSection {...props(() => deferred.promise)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })
  })
})
