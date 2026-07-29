// @vitest-environment jsdom
// GoalBar behavior: the docked strip above the composer — phase labels,
// inline edit form, and resume/clear icon actions — driven purely through
// props, no wire. Loading, absent, and complete goals render nothing.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal/client'
import { GoalBar } from '../src/client/GoalBar.tsx'
import type { GoalBarActions } from '../src/client/slots.ts'

afterEach(cleanup)

function makeGoal(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    id: 'g1' as GoalSnapshot['id'],
    revision: 1,
    objective: 'Ship the redesign',
    phase: 'active',
    maxGoalRounds: 4,
    ...over,
  }
}

function makeActions() {
  return {
    onEdit: vi.fn<GoalBarActions['onEdit']>(() => Promise.resolve({ ok: true })),
    onResume: vi.fn<GoalBarActions['onResume']>(() => Promise.resolve({ ok: true })),
    onClear: vi.fn<GoalBarActions['onClear']>(() => Promise.resolve({ ok: true })),
  } satisfies GoalBarActions
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

  it('edit swaps the strip for a prefilled form; Enter saves, empty stays disabled', async () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    const box = screen.getByRole('textbox', { name: 'Goal objective' })
    expect(box).toHaveProperty('value', 'Ship the redesign')

    fireEvent.change(box, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save goal' })).toHaveProperty('disabled', true)

    fireEvent.change(box, { target: { value: 'Ship v2' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.onEdit).toHaveBeenCalledWith('Ship v2')
    await waitFor(() => { expect(screen.getByText('Ongoing Goal')).toBeTruthy() })
  })

  it('Esc cancels the edit without calling onEdit', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Goal objective' }), { key: 'Escape' })
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()
  })

  it('the cancel button exits the form and drops the draft (re-edit starts from the objective)', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), { target: { value: 'abandoned draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Ongoing Goal')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveProperty('value', 'Ship the redesign')
  })

  it('Enter with a blank draft neither saves nor closes the form', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    const box = screen.getByRole('textbox', { name: 'Goal objective' })
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(actions.onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toBeTruthy()
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

    rerender(<GoalBar goal={makeGoal({ id: 'g2' as GoalSnapshot['id'], objective: 'New goal' })} {...actions} />)
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

  it('blocked goal without a reason carries no tooltip', () => {
    const actions = makeActions()
    render(<GoalBar goal={makeGoal({ phase: 'blocked' })} {...actions} />)
    expect(screen.getByText('Blocked Goal')).toBeTruthy()
    expect(screen.getByText('Blocked Goal').closest('[title]')).toBeNull()
  })

  it('keeps the edit draft open and reports a failed save', async () => {
    const actions = makeActions()
    actions.onEdit.mockResolvedValue({ ok: false, error: { code: 'agent-busy', message: 'stale revision' } })
    render(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    const box = screen.getByRole('textbox', { name: 'Goal objective' })
    fireEvent.change(box, { target: { value: 'retry this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

    expect((await screen.findByRole('alert')).textContent).toBe('stale revision (agent-busy)')
    expect(screen.getByRole('textbox', { name: 'Goal objective' })).toHaveProperty('value', 'retry this draft')
  })

  it('reports resume and clear failures without hiding the goal', async () => {
    const actions = makeActions()
    actions.onResume.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'resume failed' } })
    const { rerender } = render(<GoalBar goal={makeGoal({ phase: 'paused' })} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
    expect((await screen.findByRole('alert')).textContent).toBe('resume failed (internal)')

    actions.onClear.mockResolvedValue({ ok: false, error: { code: 'agent-busy', message: 'clear failed' } })
    rerender(<GoalBar goal={makeGoal()} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect((await screen.findByRole('alert')).textContent).toBe('clear failed (agent-busy)')
    expect(screen.getByText('Ship the redesign')).toBeTruthy()
  })
})
