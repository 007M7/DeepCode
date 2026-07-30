/**
 * Official-DeepSeek first-run dialog. Readiness comes from the same
 * provider/settings/credential join as the Models page; the component holds
 * only the write-only draft and viewing state.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Write-only credential wire face. */
  credentials: IApiClient['credentials']
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type DeepSeekOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & DeepSeekOnboardingInjected

/** Remove the submitted non-empty secret from any error text before it reaches the DOM. */
function redactSecret(message: string, secret: string): string {
  return message.split(secret).join('[redacted]')
}

/**
 * Render the first-run credential dialog while the official adapter exists
 * and its effective reference is writable but unconfigured.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the controlled modal or null when onboarding needs no intervention.
 */
export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { active, openSection, controller, useSnapshot, credentials, t } = props
  const state = useSnapshot(snapshot => snapshot)
  const readiness = deepSeekReadiness(state)
  const [dismissed, setDismissed] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (active && !dismissed && state.status === 'idle') void controller.load()
  }, [active, controller, dismissed, state.status])

  useEffect(() => {
    if (!active || readiness.kind !== 'credential-missing') {
      setKeyDraft('')
      setFailure(undefined)
    }
  }, [active, readiness.kind, readiness.kind === 'credential-missing' ? readiness.ref : undefined])

  const close = (): void => {
    setKeyDraft('')
    setFailure(undefined)
    setDismissed(true)
  }

  const openModels = (): void => {
    close()
    openSection('models')
  }

  const save = async (): Promise<void> => {
    /* v8 ignore next -- the form only attaches save while missing and disables it for an empty draft */
    if (readiness.kind !== 'credential-missing' || keyDraft.length === 0) return
    const secret = keyDraft
    const ref = readiness.ref
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await credentials.set({ ref, value: secret })
      if (!response.result.ok) {
        setFailure(`${t('onboardingSaveFailed')}: ${redactSecret(response.result.error.message, secret)}`)
        return
      }
      await controller.load()
      if (deepSeekReadiness(controller.store.getSnapshot()).kind !== 'configured') {
        setFailure(t('onboardingVerifyFailed'))
        return
      }
      setKeyDraft('')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFailure(`${t('onboardingSaveFailed')}: ${redactSecret(message, secret)}`)
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      await controller.load()
    } finally {
      setBusy(false)
    }
  }

  if (!active || dismissed || readiness.kind === 'loading'
    || readiness.kind === 'adapter-absent' || readiness.kind === 'configured') return null

  const unavailable = readiness.kind === 'unavailable'
  const diagnostic = unavailable && readiness.reason === 'credentials-unavailable'
    ? t('onboardingCredentialsUnavailable')
    : t('onboardingConfigurationUnavailable')
  const displayName = readiness.kind === 'credential-missing'
    ? readiness.displayName
    : 'DeepSeek'

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
          disabled={busy || (!unavailable && keyDraft.length === 0)}
          onClick={() => { void (unavailable ? retry() : save()) }}
        >
          {busy
            ? t('onboardingSaving')
            : unavailable
              ? t('retry')
              : t('onboardingSave')}
        </Button>
      )}
    >
      <div className={styles['fields']}>
        <label className={styles['field']}>
          <span className={styles['label']}>{t('provider')}</span>
          <Input
            className={styles['input'] as string}
            type="text"
            aria-label={t('provider')}
            value={displayName}
            readOnly
          />
        </label>
        {readiness.kind === 'credential-missing'
          ? (
            <label className={styles['field']}>
              <span className={styles['label']}>{t('onboardingKey')}</span>
              <Input
                className={styles['input'] as string}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-label={t('onboardingKey')}
                placeholder={t('onboardingKeyPlaceholder')}
                value={keyDraft}
                disabled={busy}
                onChange={(event) => {
                  setKeyDraft(event.target.value)
                  setFailure(undefined)
                }}
              />
            </label>
          )
          : <p className={styles['diagnostic']}>{diagnostic}</p>}
        <Button variant="ghost" size="sm" className={styles['advanced']} onClick={openModels}>
          {t('onboardingAdvanced')}
        </Button>
        {failure !== undefined ? <p className={styles['error']} role="alert">{failure}</p> : null}
      </div>
    </Modal>
  )
}
