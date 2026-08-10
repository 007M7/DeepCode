// @vitest-environment jsdom
/** Trajectory toolbar export button: click dispatch, in-flight disable, and error surfacing. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { TrajectoryToolbar, type TrajectoryToolbarProps } from '../src/client/TrajectoryToolbar.tsx'
import { zh, type TrajectoryKey } from '../src/client/locales.ts'

/** Test translator pinned to the Simplified Chinese dictionary. */
const zhT = (key: LocaleKeysOf<'trajectory'>): string => zh[key as TrajectoryKey] ?? key

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function baseProps(overrides: Partial<TrajectoryToolbarProps> = {}): TrajectoryToolbarProps {
  return {
    actualDuration: false,
    onActualDurationChange: vi.fn(),
    actualTime: false,
    onActualTimeChange: vi.fn(),
    allTurnsCollapsed: false,
    onToggleAllTurns: vi.fn(),
    allAssistantsCollapsed: false,
    onToggleAllAssistants: vi.fn(),
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    exporting: false,
    onExport: vi.fn(),
    exportError: null,
    t: zhT,
    ...overrides,
  }
}

describe('TrajectoryToolbar export', () => {
  it('renders the export button and dispatches the export callback on click', () => {
    const onExport = vi.fn()
    render(<TrajectoryToolbar {...baseProps({ onExport })} />)
    const button = screen.getByRole('button', { name: '导出会话日志' })
    fireEvent.click(button)
    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('disables the button while an export is in flight and blocks dispatch', () => {
    const onExport = vi.fn()
    render(<TrajectoryToolbar {...baseProps({ exporting: true, onExport })} />)
    const button = screen.getByRole('button', { name: '导出会话日志' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onExport).not.toHaveBeenCalled()
  })

  it('surfaces an export failure as the button title', () => {
    render(<TrajectoryToolbar {...baseProps({ exportError: '导出失败：internal boom' })} />)
    const button = screen.getByRole('button', { name: '导出会话日志' })
    expect(button.title).toBe('导出失败：internal boom')
  })
})
