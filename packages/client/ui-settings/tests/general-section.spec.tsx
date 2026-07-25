// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { GeneralSectionComponentProps } from '../src/client/contract/slots.ts'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount() {
  const renderSlot = vi.fn(
    ((key: string) => <div data-testid={`slot-${key}`} />) as GeneralSectionComponentProps['renderSlot'],
  )
  // Global standard kit stubs: the section consumes neither hook.
  const unusedHook = (() => { throw new Error('unused by GeneralSection') }) as never
  const props: GeneralSectionComponentProps = {
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    t: (key) => en[key] ?? key,
    renderSlot,
  }
  const view = render(<GeneralSection {...props} />)
  return { view, renderSlot }
}

describe('GeneralSection', () => {
  it('renders the Permission skeleton row with the disabled selector', () => {
    mount()
    expect(screen.getByText('Permission')).toBeTruthy()
    expect(screen.getByText('Choose default permission mode')).toBeTruthy()
    const selector = screen.getByRole('button', { name: /Read only/ }) as HTMLButtonElement
    expect(selector.disabled).toBe(true)
  })

  it('renders the Tool Call skeleton cubes with schema pinned selected', () => {
    mount()
    expect(screen.getByText('Tool Call')).toBeTruthy()
    const schema = screen.getByText('Schema mode')
    const code = screen.getByText('Code mode')
    expect(schema.parentElement!.className).toContain('selected')
    expect(code.parentElement!.className).not.toContain('selected')
    expect(screen.getByText('Traditional function calling — invoke tools one at a time')).toBeTruthy()
    expect(screen.getByText('Chain multiple tools with code — multi-step orchestration')).toBeTruthy()
  })

  it('renders the feature-contributed item slot after the skeleton rows', () => {
    const { renderSlot } = mount()
    expect(renderSlot).toHaveBeenCalledWith('settings.general.item', {})
    expect(screen.getByTestId('slot-settings.general.item')).toBeTruthy()
  })
})
