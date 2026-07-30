// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { WelcomeNoticeProps } from '../src/client/WelcomeNotice.tsx'
import { WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import { zh } from '../src/client/locales.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

afterEach(cleanup)

function response<T>(value: T) {
  return { rpcId: 'welcome-rpc' as never, result: { ok: true as const, value } }
}

function mount(version?: string, mutateImpl: () => Promise<unknown> = () => Promise.resolve(response({}))) {
  const mutate = vi.fn(mutateImpl)
  const api = {
    settings: {
      describe: () => Promise.resolve(response({
        writable: true,
        namespaces: [{
          ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
          schema: {},
          value: version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }],
      })),
      mutate,
    },
  }
  const controller = new WelcomeNoticeStore(api as never)
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: WelcomeNoticeProps = {
    stepId: 'welcome-notice',
    complete,
    openSection: vi.fn(),
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    t: key => zh[key] ?? key,
  }
  return { ...render(<WelcomeNotice {...props} />), complete, controller, mutate }
}

describe('WelcomeNotice', () => {
  it('renders the owner copy with one primary action and no dismissal control', async () => {
    const h = mount()
    const dialog = await screen.findByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    for (const text of [
      WELCOME_NOTICE_COPY.zh.title,
      WELCOME_NOTICE_COPY.zh.lead,
      WELCOME_NOTICE_COPY.zh.feedbackTitle,
      WELCOME_NOTICE_COPY.zh.feedbackBody,
      WELCOME_NOTICE_COPY.zh.closing,
      WELCOME_NOTICE_COPY.zh.quote,
    ]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(dialog.textContent?.match(/感谢您试用 DeepSeek Harness/g) ?? []).toHaveLength(1)
    const buttons = dialog.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('completes only after the acknowledgement write commits', async () => {
    const h = mount()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }))
    await act(async () => { await Promise.resolve() })
    expect(h.mutate).toHaveBeenCalledOnce()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('skips itself when this exact version was already acknowledged', async () => {
    const h = mount(WELCOME_NOTICE_VERSION)
    await act(async () => { await h.controller.load() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('keeps the sole action disabled while saving and reports a refused write', async () => {
    let resolveWrite!: (value: unknown) => void
    const write = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const h = mount(undefined, () => write)
    await screen.findByRole('dialog')
    const action = screen.getByRole<HTMLButtonElement>('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })
    fireEvent.click(action)
    expect(action.disabled).toBe(true)
    resolveWrite({
      rpcId: 'welcome-refused' as never,
      result: { ok: false, error: { code: 'settings-rejected', message: 'read only', details: { ns: WELCOME_NOTICE_SETTINGS_NAMESPACE } } },
    })
    expect((await screen.findByRole('alert')).textContent).toBe('暂时无法保存确认状态，请重试。')
    expect(h.complete).not.toHaveBeenCalled()
  })
})
