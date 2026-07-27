// @vitest-environment jsdom
/**
 * Provider-grouped selector behavior: compact model-only trigger, grouped
 * radio menu, retry/error states, successful and failed selection, outside
 * dismissal, and keyboard focus navigation.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, ModelSelectionSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelSelectorProps } from '../src/client/contract.ts'
import { ModelSelector } from '../src/client/ModelSelector.tsx'

afterEach(cleanup)

const ready: ModelSelectionSnapshot = {
  current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', description: '快速响应' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '复杂任务' },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
    },
  ],
  failures: [],
  status: 'ready',
  error: null,
}

function setup(
  selection: ModelSelectionSnapshot = ready,
  locked = false,
) {
  let current = { modelSelection: selection } as unknown as ConversationSnapshot
  const useSession = ((selector: (snapshot: ConversationSnapshot) => unknown) =>
    selector(current)) as ModelSelectorProps['useSession']
  const refreshModels = vi.fn()
  const retryModelOperation = vi.fn(() => Promise.resolve(false))
  const selectModel = vi.fn((_target: ModelTarget) => Promise.resolve(true))
  const props: ModelSelectorProps = {
    sessionId: 'selector-session' as never,
    locked,
    useSession,
    useSessions: ((selector: (snapshot: never) => unknown) =>
      selector({} as never)) as ModelSelectorProps['useSessions'],
    useWorkspaces: ((selector: (snapshot: never) => unknown) =>
      selector({} as never)) as ModelSelectorProps['useWorkspaces'],
    useInput: ((selector: (snapshot: never) => unknown) =>
      selector({} as never)) as ModelSelectorProps['useInput'],
    inputActions: {} as ModelSelectorProps['inputActions'],
    refreshModels,
    retryModelOperation,
    selectModel,
  }
  const view = render(<ModelSelector {...props} />)
  return {
    view,
    refreshModels,
    retryModelOperation,
    selectModel,
    update(
      next: ModelSelectionSnapshot,
    ) {
      current = { modelSelection: next } as unknown as ConversationSnapshot
      view.rerender(<ModelSelector {...props} />)
    },
  }
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: /选择模型，当前/ })
}

describe('model selector', () => {
  it('shows the catalog name, opens upward into provider groups, and marks the current radio item', () => {
    const { refreshModels } = setup()
    expect(refreshModels).toHaveBeenCalledTimes(1)
    expect(trigger().textContent).toBe('DeepSeek-V4-Flash')
    expect(trigger().textContent).not.toContain('deepseek/')
    expect(trigger().title).toBe('DeepSeek-V4-Flash')

    fireEvent.click(trigger())
    expect(refreshModels).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('menu', { name: '模型' })).toBeTruthy()
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(screen.getByText('OpenAI')).toBeTruthy()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(row => row.querySelector('[class*="modelName"]')?.textContent))
      .toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GPT-5'])
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
    expect(rows[1]?.getAttribute('aria-checked')).toBe('false')
    expect(rows.some(row => row.textContent?.includes('deepseek/deepseek'))).toBe(false)
  })

  it('keeps the menu open on failure, closes after success, and closes current selection without an RPC', async () => {
    const { selectModel } = setup()
    selectModel.mockResolvedValueOnce(false)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    await waitFor(() => { expect(selectModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-v4-pro' }) })
    expect(screen.getByRole('menu')).toBeTruthy()

    selectModel.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5/ }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Flash/ }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(selectModel).toHaveBeenCalledTimes(2)
  })

  it('renders loading, empty, partial-provider, operation-error, and unavailable-current states with retries', () => {
    const error = { code: 'internal' as const, message: 'wire down', details: {} }
    const { refreshModels, retryModelOperation, update } = setup({
      ...ready,
      current: { provider: 'missing', model: 'private-preview-with-a-very-long-name' },
      failures: [{ id: 'offline', name: 'Offline', message: 'catalog down' }],
      status: 'error',
      error,
    })
    expect(trigger().textContent).toBe('private-preview-with-a-very-long-name')
    fireEvent.click(trigger())
    expect(screen.getByText(/模型操作失败：wire down/)).toBeTruthy()
    expect(screen.getByText(/Offline 加载失败：catalog down/)).toBeTruthy()
    expect(screen.getByText(/当前提供方 missing 未注册/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)
    expect(retryModelOperation).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[1]!)
    expect(refreshModels).toHaveBeenCalledTimes(3)

    update({ current: null, groups: [], failures: [], status: 'loading', error: null })
    expect(screen.getByText('正在刷新模型列表…')).toBeTruthy()
    update({ current: null, groups: [], failures: [], status: 'ready', error: null })
    expect(screen.getByText('没有可用的模型。')).toBeTruthy()
  })

  it('closes after retrying a failed selection successfully', async () => {
    const { retryModelOperation } = setup({
      ...ready,
      status: 'error',
      error: {
        code: 'model-unavailable',
        message: 'temporary failure',
        details: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    })
    retryModelOperation.mockResolvedValueOnce(true)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('supports Arrow/Home/End/Escape navigation and restores focus to the trigger', async () => {
    setup()
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[0])
    })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[1])
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[2])
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[0])
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[2])
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger())
    })
  })

  it('opens ArrowUp on the last option, disables rows while selecting, and dismisses outside', async () => {
    const { update } = setup()
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' })
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[2])
    })
    update({ ...ready, status: 'selecting' })
    expect(screen.getByRole('menu').getAttribute('aria-busy')).toBe('true')
    expect(screen.getAllByRole('menuitemradio').every(row => (row as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('disables the trigger when the model-control seat is locked', () => {
    setup(ready, true)
    expect(trigger().disabled).toBe(true)
  })
})
