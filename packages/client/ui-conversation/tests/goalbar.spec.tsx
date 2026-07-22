// @vitest-environment jsdom
// GoalBar behavior: the docked strip above the composer — phase labels,
// inline edit form, and resume/clear icon actions — driven purely through
// props, no wire. Loading, absent, and complete goals render nothing.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalView } from '@deepseek-ai/dsh-client-runtime/client'
import { GoalBar } from '../src/client/skeleton/GoalBar.tsx'
import type { GoalBarActions } from '../src/client/contract/slots.ts'

afterEach(cleanup)

function makeGoal(over: Partial<GoalView> = {}): GoalView {
  return {
    id: 'g1' as GoalView['id'],
    revision: 1,
    objective: 'Ship the redesign',
    phase: 'active',
    maxGoalRounds: 4,
    roundsStarted: 1,
    createdAt: 1,
    updatedAt: 2,
    activation: 'armed',
    ...over,
  }
}

function makeActions(): { [K in keyof GoalBarActions]: ReturnType<typeof vi.fn<GoalBarActions[K]>> } {
  return {
    onEdit: vi.fn<GoalBarActions['onEdit']>(),
    onResume: vi.fn<GoalBarActions['onResume']>(),
    onClear: vi.fn<GoalBarActions['onClear']>(),
  }
}

describe('GoalBar', () => {
  it('renders nothing while loading, absent, or when the goal is complete', () => {
    const actions = makeActions()
    const loading = render(<GoalBar goal={undefined} {...actions} />)
    expect(loading.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalBar goal={null} {...actions} />)
    expect(absent.container.firstChild).toBeNull()
    cleanup()

    const complete = render(<GoalBar goal={makeGoal({ phase: 'complete' })} {...actions} />)
    expect(complete.container.firstChild).toBeNull()
  })

  it('active goal: sparkle, "Ongoing Goal", truncated objective, edit and clear actions', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(actions.onClear).toHaveBeenCalledTimes(1)
  })

  it('edit swaps the strip for a prefilled form; Enter saves, empty stays disabled', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    const box = screen.getByRole('textbox', { name: 'Goal objective' })
    expect((box as HTMLInputElement).value).toBe('Ship the redesign')

    fireEvent.change(box, { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Save goal' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(box, { target: { value: 'Ship v2' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.onEdit).toHaveBeenCalledWith('Ship v2')
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()
  })

  it('Esc cancels the edit without calling onEdit', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Goal objective' }), { key: 'Escape' })
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()
  })

  it('paused goal: "Paused Goal" with a resume action before edit', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal({ phase: 'paused' })} {...actions} />)
    expect(screen.getByText('Paused Goal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
    expect(actions.onResume).toHaveBeenCalledTimes(1)
  })

  it('a new goal identity drops the edit form (no stale draft over the new goal)', () => {
    const actions = makeActions()
    const { rerender } = render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'stale draft' } })

    rerender(<GoalBar goal={makeGoal({ id: 'g2' as GoalView['id'], objective: 'New goal' })} {...actions} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()
    expect(screen.getByText('New goal')).toBeTruthy()

    rerender(<GoalBar goal={null} {...actions} />)
    expect(screen.queryByText('Ongoing Goal')).toBeNull()
  })

  it('blocked goal: "Blocked Goal" with the block reason as the strip tooltip', () => {
    const actions = makeActions()
    const goal = makeGoal({ phase: 'blocked', blockedReason: { code: 'stalled', message: 'No progress in 3 rounds' } })
    render(<GoalBar goal={goal} {...actions} />)
    expect(screen.getByText('Blocked Goal')).toBeTruthy()
    expect(screen.getByText('Blocked Goal').closest('[title]')?.getAttribute('title')).toBe('No progress in 3 rounds')
  })
})
