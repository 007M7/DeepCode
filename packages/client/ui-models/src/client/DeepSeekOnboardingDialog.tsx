/**
 * Official-DeepSeek first-run dialog. Readiness comes from the same
 * provider/settings/credential join as the Models page; the prompt only
 * routes the user to that page's single credential editor.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
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

/**
 * Prompt a first-run user to open Models while the official adapter exists
 * and its effective credential is not configured.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the controlled modal or null when onboarding needs no intervention.
 */
export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { active, openSection, controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)
  const readiness = deepSeekReadiness(state)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (active && !dismissed && state.status === 'idle') void controller.load()
  }, [active, controller, dismissed, state.status])

  const close = (): void => {
    setDismissed(true)
  }

  const openModels = (): void => {
    close()
    openSection('models')
  }

  if (!active || dismissed || readiness.kind === 'loading'
    || readiness.kind === 'adapter-absent' || readiness.kind === 'configured') return null

  const unavailable = readiness.kind === 'unavailable'
  const diagnostic = unavailable && readiness.reason === 'credentials-unavailable'
    ? t('onboardingCredentialsUnavailable')
    : t('onboardingConfigurationUnavailable')

  return (
    <Modal
      open
      onClose={close}
      title={unavailable ? t('onboardingUnavailableTitle') : t('onboardingTitle')}
      closeLabel={t('onboardingLater')}
      {...(unavailable ? {} : { description: t('onboardingDescription') })}
      className={styles['dialog'] as string}
      footer={(
        <Button
          variant="primary"
          className={styles['primary']}
          onClick={openModels}
        >
          {t('onboardingGoToSettings')}
        </Button>
      )}
    >
      {unavailable ? <p className={styles['diagnostic']}>{diagnostic}</p> : undefined}
    </Modal>
  )
}
