// @vitest-environment jsdom
/** First-run DeepSeek dialog behavior over the shared Models join. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingDialogProps } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `onboarding-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `onboarding-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

function harness(options: {
  provider?: boolean
  literal?: boolean
  configured?: () => boolean
  credential?: { source?: string; writable: boolean }
  describeFailure?: string
  set?: (payload: { ref: string; value: string }) => Promise<RpcResponse<{}>>
} = {}) {
  let fileConfigured = false
  const configured = options.configured ?? (() => fileConfigured)
  const set = vi.fn(options.set ?? ((payload: { ref: string; value: string }) => {
    fileConfigured = payload.value.length > 0
    return Promise.resolve(ok({}))
  }))
  const face = {
    llm: {
      providers: () => Promise.resolve(ok({
        providers: options.provider === false
          ? []
          : [{
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek',
            settingsPath: [],
            active: true,
          }],
      })),
    },
    settings: {
      describe: () => Promise.resolve(ok({
        writable: true,
        namespaces: [{
          ns: 'llm-deepseek',
          schema: {},
          value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
          applies: 'live' as const,
          secrets: [{ path: ['apiKey'], set: options.literal === true }],
        }],
      })),
    },
    credentials: {
      describe: () => options.describeFailure === undefined
        ? Promise.resolve(ok({
          credentials: {
            DEEPSEEK_API_KEY: {
              configured: configured(),
              ...configured() && options.credential?.source !== undefined
                ? { source: options.credential.source }
                : {},
              writable: options.credential?.writable ?? true,
            },
          },
        }))
        : Promise.resolve(fail(options.describeFailure)),
      set,
    },
  }
  const controller = new ModelsSettingsStore(face as never)
  const openSection = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: DeepSeekOnboardingDialogProps = {
    active: true,
    openSection,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    credentials: face.credentials as never,
    t: key => en[key],
  }
  return { controller, face, openSection, props, set, configure: () => { fileConfigured = true } }
}

describe('DeepSeekOnboardingDialog', () => {
  it('loads on first entry and presents an accessible write-only key form', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    const dialog = await screen.findByRole('dialog', { name: en.onboardingTitle })
    expect(dialog).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.provider).value).toBe('DeepSeek')
    const key = screen.getByLabelText<HTMLInputElement>(en.onboardingKey)
    expect(key.type).toBe('password')
    expect(key.autocomplete).toBe('off')
    expect(key.getAttribute('spellcheck')).toBe('false')
  })

  it('stores through credentials.set, verifies through describe, clears the draft, and closes', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.onboardingKey)
    const secret = 'test-onboarding-secret'
    fireEvent.change(key, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(h.set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: secret })
    expect(document.body.textContent).not.toContain(secret)
    expect(document.documentElement.outerHTML).not.toContain(secret)
  })

  it('keeps a business failure open without echoing the secret', async () => {
    const secret = 'business-secret'
    const h = harness({
      set: payload => Promise.resolve(fail(`refused ${payload.value}`)),
    })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.onboardingKey)
    fireEvent.change(key, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('[redacted]')
    expect(alert.textContent).not.toContain(secret)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave }).disabled).toBe(false)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.change(key, { target: { value: 'replacement' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows saving state and reports a failed configured-state verification', async () => {
    let settle: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { settle = resolve })
    const h = harness({
      set: async () => {
        await pending
        return ok({})
      },
    })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    fireEvent.change(await screen.findByLabelText(en.onboardingKey), { target: { value: 'verify-secret' } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    expect(screen.getByRole('button', { name: en.onboardingSaving })).toBeTruthy()
    settle?.()
    expect((await screen.findByRole('alert')).textContent).toBe(en.onboardingVerifyFailed)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave }).disabled).toBe(false)
  })

  it('recovers busy state after a transport rejection without an unhandled rejection', async () => {
    const secret = 'transport-secret'
    const h = harness({
      set: () => Promise.reject(new Error(`transport rejected ${secret}`)),
    })
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    try {
      render(<DeepSeekOnboardingDialog {...h.props} />)
      const key = await screen.findByLabelText<HTMLInputElement>(en.onboardingKey)
      fireEvent.change(key, { target: { value: secret } })
      fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).not.toContain(secret)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.onboardingSave }).disabled).toBe(false)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })

  it('stringifies a non-Error transport rejection without exposing its secret', async () => {
    const secret = 'plain-rejection-secret'
    const h = harness({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      set: () => Promise.reject(`transport refused ${secret}`),
    })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    fireEvent.change(await screen.findByLabelText(en.onboardingKey), { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: en.onboardingSave }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('[redacted]')
    expect(alert.textContent).not.toContain(secret)
  })

  it('cancels without writing and opens the Models section through the owner callback', async () => {
    const cancelled = harness()
    const first = render(<DeepSeekOnboardingDialog {...cancelled.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cancelled.set).not.toHaveBeenCalled()
    first.unmount()

    const advanced = harness()
    render(<DeepSeekOnboardingDialog {...advanced.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingAdvanced }))
    expect(advanced.openSection).toHaveBeenCalledWith('models')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(advanced.set).not.toHaveBeenCalled()
  })

  it('shows an actionable deployment diagnostic when credentials are unavailable', async () => {
    const h = harness({ describeFailure: 'credentials service is absent' })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
    expect(screen.getByText(en.onboardingCredentialsUnavailable)).toBeTruthy()
    expect(screen.queryByLabelText(en.onboardingKey)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.retry }).disabled).toBe(false)
    })
  })

  it('uses the deployment diagnostic for a missing read-only credential', async () => {
    const h = harness({ credential: { writable: false } })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
    expect(screen.getByText(en.onboardingConfigurationUnavailable)).toBeTruthy()
    expect(screen.queryByLabelText(en.onboardingKey)).toBeNull()
  })

  it('skips an absent adapter and already-configured literal or environment credentials', async () => {
    for (const h of [
      harness({ provider: false }),
      harness({ literal: true, describeFailure: 'credential seam absent' }),
      harness({ configured: () => true, credential: { source: 'env', writable: false } }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await act(async () => { await h.controller.load() })
      expect(screen.queryByRole('dialog')).toBeNull()
      view.unmount()
    }
  })

  it('closes when an external credential invalidation refreshes the shared join', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    h.configure()
    await act(async () => { await h.controller.load() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('clears a typed draft when the onboarding owner becomes inactive', async () => {
    const h = harness()
    const view = render(<DeepSeekOnboardingDialog {...h.props} />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.onboardingKey)
    fireEvent.change(key, { target: { value: 'ephemeral' } })
    view.rerender(<DeepSeekOnboardingDialog {...h.props} active={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<DeepSeekOnboardingDialog {...h.props} active />)
    expect((await screen.findByLabelText<HTMLInputElement>(en.onboardingKey)).value).toBe('')
  })
})
