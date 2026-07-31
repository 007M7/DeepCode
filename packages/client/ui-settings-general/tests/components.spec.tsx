// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { GeneralSectionComponentProps } from '../src/client/GeneralSection.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is settings ∪ common; the stub answers from the
// package dictionary and falls back to the key like the real chain.
const t: GeneralSectionComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

// Global standard kit stubs: none of these components consume the hooks.
const unusedHook = (() => { throw new Error('unused by settings-general components') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook }

describe('chrome content', () => {
  it('TriggerContent renders the icon with the label in the wide column', () => {
    const { container } = render(<TriggerContent {...kit} wide t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('TriggerContent drops the label in the rail state', () => {
    const { container } = render(<TriggerContent {...kit} wide={false} t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('HeaderContent and CloseLabel render their translated text', () => {
    render(<HeaderContent {...kit} t={t} />)
    render(<CloseLabel {...kit} t={t} />)
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })
})

describe('GeneralSection', () => {
  function mount() {
    const renderSlot = vi.fn(
      ((key: string) => <div data-testid={`slot-${key}`} />) as GeneralSectionComponentProps['renderSlot'],
    )
    const props: GeneralSectionComponentProps = { ...kit, t, renderSlot }
    const view = render(<GeneralSection {...props} />)
    return { view, renderSlot }
  }

  it('renders the Permission skeleton row with the disabled selector', () => {
    mount()
    expect(screen.getByText('Permission')).toBeTruthy()
    expect(screen.getByText('Choose default permission mode')).toBeTruthy()
    const selector = screen.getByRole<HTMLButtonElement>('button', { name: /Read only/ })
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
