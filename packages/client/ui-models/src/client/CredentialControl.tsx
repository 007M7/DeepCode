/**
 * Credential-reference control: renders the reference NAME as the editable
 * settings field, its configured state as a badge, and an inline write-only
 * key input that stores the value through `credentials.set`. The value never
 * renders back — the wire has no read path for it.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SchemaFieldContext } from '@deepseek-ai/dsh-client-schema-form'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link CredentialControl}. */
export interface CredentialControlProps {
  /** The `apiKeyEnv` leaf position inside the provider editor's form. */
  context: SchemaFieldContext
  /** Credentials wire face. */
  credentials: IApiClient['credentials']
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** The effective reference name this control addresses. */
function refOf(context: SchemaFieldContext): string | undefined {
  const value = context.draftValue ?? context.fallbackValue
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Render the credential-reference field with its live state and key input.
 * @param props - field context, wire face, and copy.
 * @returns the control column.
 */
export function CredentialControl(props: CredentialControlProps): ReactNode {
  const { context, credentials, t } = props
  const ref = refOf(context)
  const [state, setState] = useState<CredentialView | undefined>(undefined)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let stale = false
    setState(undefined)
    if (ref === undefined) return undefined
    void credentials.describe({ refs: [ref] }).then((response) => {
      if (stale || !response.result.ok) return
      setState(response.result.value.credentials[ref])
    })
    return () => { stale = true }
  }, [credentials, ref])

  const badge = state === undefined
    ? null
    : state.configured
      ? (
        <span className={styles['badgeOk']}>
          {t('credentialConfigured')}
          {state.source === 'env' ? ` · ${t('credentialFromEnv')}` : ''}
        </span>
      )
      : <span className={styles['badgeWarn']}>{t('credentialMissing')}</span>

  const storeKey = async (): Promise<void> => {
    /* v8 ignore next -- the save button is disabled while no reference or draft exists */
    if (ref === undefined || keyDraft.length === 0) return
    setBusy(true)
    setFailure(undefined)
    const response = await credentials.set({ ref, value: keyDraft })
    setBusy(false)
    if (!response.result.ok) {
      setFailure(response.result.error.message)
      return
    }
    setKeyDraft('')
    const described = await credentials.describe({ refs: [ref] })
    if (described.result.ok) setState(described.result.value.credentials[ref])
  }

  return (
    <div className={styles['credential']}>
      <div className={styles['credentialRefRow']}>
        <input
          className={styles['input']}
          type="text"
          value={typeof context.draftValue === 'string' ? context.draftValue : ''}
          placeholder={typeof context.fallbackValue === 'string' ? context.fallbackValue : undefined}
          aria-label={t('credentialRef')}
          disabled={context.disabled}
          onChange={(event) => {
            const next = event.target.value
            if (next === '') context.clearValue()
            else context.setValue(next)
          }}
        />
        {badge}
      </div>
      {ref !== undefined && state?.writable !== false
        ? (
          <div className={styles['credentialKeyRow']}>
            <input
              className={styles['input']}
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder={t('keyPlaceholder')}
              disabled={context.disabled || busy}
              aria-label={t('keyInput')}
              onChange={(event) => { setKeyDraft(event.target.value) }}
            />
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={context.disabled || busy || keyDraft.length === 0}
              onClick={() => { void storeKey() }}
            >
              {t('keySave')}
            </button>
          </div>
        )
        : null}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
    </div>
  )
}
