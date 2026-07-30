/**
 * Official-DeepSeek first-run dialog. Readiness comes from the same
 * provider/settings/credential join as the Models page; the prompt only
 * routes the user to that page's single credential editor.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { DeepSeekReadiness, ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { deepSeekReadiness } from './store.ts'
import type { en } from './locales.ts'
import styles from './DeepSeekOnboardingDialog.module.css'

/** Injected dependencies of {@link DeepSeekOnboardingDialog}. */
export interface DeepSeekOnboardingInjected {
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Subscription hook bound to the shared join snapshot. */
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type DeepSeekOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & DeepSeekOnboardingInjected

type UnavailableReason = Extract<DeepSeekReadiness, { kind: 'unavailable' }>['reason']

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected DeepSeek onboarding state')
}

function unavailableDiagnostic(
  reason: UnavailableReason,
  t: DeepSeekOnboardingInjected['t'],
): string {
  switch (reason) {
    case 'load-failed':
      return t('onboardingLoadFailed')
    case 'credentials-unavailable':
      return t('onboardingCredentialsUnavailable')
    case 'settings-read-only':
    case 'credential-read-only':
      return t('onboardingReadOnly')
    case 'provider-inactive':
    case 'settings-unavailable':
    case 'credential-ref-unavailable':
      return t('onboardingConfigurationUnavailable')
    /* v8 ignore next -- every current unavailable reason is handled above */
    default:
      return assertNever(reason)
  }
}

/**
 * Prompt a first-run user to open Models while the official adapter exists
 * and its effective credential is not configured.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the controlled modal or null when onboarding needs no intervention.
 */
export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { complete, openSection, controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)
  const readiness = deepSeekReadiness(state)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (readiness.kind === 'adapter-absent' || readiness.kind === 'configured') complete()
  }, [complete, readiness.kind])

  const openModels = (): void => {
    complete()
    openSection('models')
  }

  let unavailableReason: UnavailableReason | undefined
  switch (readiness.kind) {
    case 'loading':
    case 'adapter-absent':
    case 'configured':
      return null
    case 'credential-missing':
      unavailableReason = undefined
      break
    case 'unavailable':
      unavailableReason = readiness.reason
      break
    /* v8 ignore next -- every current readiness variant is handled above */
    default:
      return assertNever(readiness)
  }
  const unavailable = unavailableReason !== undefined
  const diagnostic = unavailableReason === undefined
    ? undefined
    : unavailableDiagnostic(unavailableReason, t)

  return (
    <Modal
      open
      onClose={complete}
      title={unavailable ? t('onboardingUnavailableTitle') : t('onboardingTitle')}
      closeLabel={t('onboardingLater')}
      {...(unavailable ? {} : { description: t('onboardingDescription') })}
      className={styles['dialog'] as string}
      footer={(
        <Button
          variant="primary"
          className={styles['primary']}
          autoFocus
          onClick={openModels}
        >
          {t('onboardingGoToSettings')}
        </Button>
      )}
    >
      {diagnostic === undefined ? undefined : <p className={styles['diagnostic']}>{diagnostic}</p>}
    </Modal>
  )
}
