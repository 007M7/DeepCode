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

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected DeepSeek onboarding state')
}

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

  if (!active || dismissed) return null

  switch (readiness.kind) {
    case 'loading':
    case 'adapter-absent':
    case 'configured':
    case 'unavailable':
      return null
    case 'credential-missing':
      break
    /* v8 ignore next -- every current readiness variant is handled above */
    default:
      return assertNever(readiness)
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('onboardingTitle')}
      closeLabel={t('onboardingLater')}
      description={t('onboardingDescription')}
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
    />
  )
}
