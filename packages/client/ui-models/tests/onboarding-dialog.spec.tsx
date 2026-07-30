// @vitest-environment jsdom
/** First-run DeepSeek prompt behavior over the shared Models join. */
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
  providerActive?: boolean
  settingsNamespace?: boolean
  apiKeyEnv?: string | null
  literal?: boolean
  configured?: () => boolean
  credential?: { source?: string; writable: boolean }
  describeFailure?: string
  settingsWritable?: boolean
  providersRejectOnce?: boolean
} = {}) {
  let fileConfigured = false
  let rejectProviders = options.providersRejectOnce === true
  const configured = options.configured ?? (() => fileConfigured)
  const face = {
    llm: {
      providers: () => {
        if (rejectProviders) {
          rejectProviders = false
          return Promise.reject(new Error('provider transport unavailable'))
        }
        return Promise.resolve(ok({
          providers: options.provider === false
            ? []
            : [{
              provider: 'deepseek-official',
              displayName: 'DeepSeek',
              settingsNs: 'llm-deepseek',
              settingsPath: [],
              active: options.providerActive ?? true,
            }],
        }))
      },
    },
    settings: {
      describe: () => Promise.resolve(ok({
        writable: options.settingsWritable ?? true,
        namespaces: options.settingsNamespace === false
          ? []
          : [{
            ns: 'llm-deepseek',
            schema: {},
            value: options.apiKeyEnv === null
              ? {}
              : { apiKeyEnv: options.apiKeyEnv ?? 'DEEPSEEK_API_KEY' },
            applies: 'live' as const,
            secrets: [{ path: ['apiKey'], set: options.literal === true }],
            revision: 0,
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
    },
  }
  const controller = new ModelsSettingsStore(face as never)
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: DeepSeekOnboardingDialogProps = {
    stepId: 'deepseek-official',
    complete,
    openSection,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    t: key => en[key],
  }
  return { controller, complete, openSection, props, configure: () => { fileConfigured = true } }
}

describe('DeepSeekOnboardingDialog', () => {
  it('loads on first entry and presents one accessible route to Models', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(screen.getByText(en.onboardingDescription)).toBeTruthy()
    const action = screen.getByRole('button', { name: en.onboardingGoToSettings })
    expect(action).toBeTruthy()
    expect(document.activeElement).toBe(action)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens the Models section and dismisses the prompt', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingGoToSettings }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).toHaveBeenCalledWith('models')
  })

  it('allows configure-later dismissal without opening settings', async () => {
    const h = harness()
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.onboardingLater }))
    expect(h.complete).toHaveBeenCalledOnce()
    expect(h.openSection).not.toHaveBeenCalled()
  })

  it('routes an unavailable credential deployment to Models with a diagnostic', async () => {
    const h = harness({ describeFailure: 'credentials service is absent' })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
    expect(screen.getByText(en.onboardingCredentialsUnavailable)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.onboardingGoToSettings }))
    expect(h.openSection).toHaveBeenCalledWith('models')
  })

  it('explains read-only credential and settings deployments', async () => {
    for (const h of [
      harness({ credential: { writable: false } }),
      harness({ settingsWritable: false }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
      expect(screen.getByText(en.onboardingReadOnly)).toBeTruthy()
      view.unmount()
    }
  })

  it('distinguishes an initial transport failure from deployment misconfiguration', async () => {
    const h = harness({ providersRejectOnce: true })
    render(<DeepSeekOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
    expect(screen.getByText(en.onboardingLoadFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.onboardingGoToSettings }))
    expect(h.openSection).toHaveBeenCalledWith('models')
  })

  it('uses the configuration diagnostic for inactive or unresolvable adapters', async () => {
    for (const h of [
      harness({ providerActive: false }),
      harness({ settingsNamespace: false }),
      harness({ apiKeyEnv: null }),
    ]) {
      const view = render(<DeepSeekOnboardingDialog {...h.props} />)
      await screen.findByRole('dialog', { name: en.onboardingUnavailableTitle })
      expect(screen.getByText(en.onboardingConfigurationUnavailable)).toBeTruthy()
      view.unmount()
    }
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
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
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
    expect(h.complete).toHaveBeenCalledOnce()
  })
})
