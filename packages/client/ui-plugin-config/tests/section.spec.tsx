// @vitest-environment jsdom
/**
 * What the section and its cards show: the empty line when no plugin
 * contributed one, a card that renders nothing while its namespace is
 * unavailable, and the read-only notice a locked document produces.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { PluginConfigSection } from '../src/client/PluginConfigSection.tsx'
import type { PluginConfigSectionProps } from '../src/client/PluginConfigSection.tsx'
import { WebSearchCard } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-store.ts'
import type { BashCardState } from '../src/client/bash-store.ts'
import type { WebSearchCardState } from '../src/client/web-search-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

function renderSection(cardCount: number, cards = 'cards') {
  const props = {
    t,
    cardCount,
    renderSlot: () => <li>{cards}</li>,
  } as unknown as PluginConfigSectionProps
  render(<PluginConfigSection {...props} />)
}

function renderBash(state: Partial<BashCardState> = {}) {
  const store = createSnapshotStore<BashCardState>({
    available: true,
    writable: true,
    timeoutMs: { value: 60_000, overridden: false },
    maxOutputBytes: { value: 64_000, overridden: false },
    ...state,
  })
  const actions = {
    setTimeoutMs: vi.fn(),
    resetTimeoutMs: vi.fn(),
    setMaxOutputBytes: vi.fn(),
    resetMaxOutputBytes: vi.fn(),
  }
  const props = {
    ...actions,
    t,
    useBashCard: bindSnapshotSelector(store),
  } as unknown as BashCardProps
  render(<BashCard {...props} />)
  return actions
}

describe('PluginConfigSection', () => {
  it('says so when no plugin contributed a card', () => {
    renderSection(0)

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('cards')).toBeNull()
  })

  it('renders the card list once a plugin contributed one', () => {
    renderSection(1)

    expect(screen.getByText('cards')).toBeTruthy()
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('leads with its own heading and intro', () => {
    renderSection(1)

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })
})

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderBash()
    expect(screen.getByText(en.bashTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.bashMaxOutputBytes)).toBeTruthy()
  })

  it('commits an edited field through its action', () => {
    const actions = renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    const input = screen.getByLabelText(en.bashTimeoutMs)
    fireEvent.change(input, { target: { value: '9000' } })
    fireEvent.blur(input)

    expect(actions.setTimeoutMs).toHaveBeenCalledWith(9_000)
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: { value: 9_000, overridden: true } })
    fireEvent.click(screen.getByText(en.bashTitle))

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetTimeoutMs).toHaveBeenCalledOnce()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })
})

describe('AgentLoopCard', () => {
  it('edits the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      available: true,
      writable: true,
      maxParallelToolCalls: { value: 10, overridden: false },
    })
    const setMaxParallelToolCalls = vi.fn()
    const props = {
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
      setMaxParallelToolCalls,
      resetMaxParallelToolCalls: vi.fn(),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    const input = screen.getByLabelText(en.agentLoopMaxParallel)
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.blur(input)

    expect(setMaxParallelToolCalls).toHaveBeenCalledWith(2)
  })
})

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      available: true,
      writable: true,
      baseURL: { value: '', overridden: false },
      maxUses: { value: 5, overridden: false },
      apiKeyRef: 'DEEPSEEK_API_KEY',
      apiKeyConfigured: false,
      ...state,
    })
    const actions = {
      setBaseUrl: vi.fn(),
      resetBaseUrl: vi.fn(),
      setMaxUses: vi.fn(),
      resetMaxUses: vi.fn(),
      setApiKey: vi.fn(),
    }
    const props = {
      ...actions,
      t,
      useWebSearchCard: bindSnapshotSelector(store),
    } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByText(en.webSearchApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const key = screen.getByLabelText(en.webSearchApiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })
    fireEvent.blur(key)

    expect(actions.setApiKey).toHaveBeenCalledWith('ds-secret')
  })

  it('commits the endpoint and the search budget', () => {
    const actions = renderWebSearch()
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const endpoint = screen.getByLabelText(en.webSearchBaseUrl)
    fireEvent.change(endpoint, { target: { value: 'https://search.test/v1' } })
    fireEvent.blur(endpoint)
    const budget = screen.getByLabelText(en.webSearchMaxUses)
    fireEvent.change(budget, { target: { value: '3' } })
    fireEvent.blur(budget)

    expect(actions.setBaseUrl).toHaveBeenCalledWith('https://search.test/v1')
    expect(actions.setMaxUses).toHaveBeenCalledWith(3)
  })
})
