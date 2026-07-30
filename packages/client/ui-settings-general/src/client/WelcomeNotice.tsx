/** Product-wide, versioned first-run welcome step. */

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { WelcomeNoticeState, WelcomeNoticeStore } from './welcome-store.ts'
import css from './WelcomeNotice.module.css'

/** Registrant-owned dependencies of {@link WelcomeNotice}. */
export interface WelcomeNoticeInjected {
  controller: WelcomeNoticeStore
  useSnapshot: SnapshotSelectorHook<WelcomeNoticeState>
  t: (key: string) => string
}

/** Coordinator owner props plus the welcome step's injected face. */
export type WelcomeNoticeProps = PropsRuntime<'settings.onboarding'> & WelcomeNoticeInjected

/** Render the mandatory notice until its current version commits durably. */
export function WelcomeNotice(props: WelcomeNoticeProps): ReactNode {
  const { complete, controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)
  const finished = useRef(false)
  const finish = useCallback((): void => {
    if (finished.current) return
    finished.current = true
    complete()
  }, [complete])

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (state.acknowledged) finish()
  }, [finish, state.acknowledged])

  if (state.status === 'idle' || state.status === 'loading' || state.acknowledged) return null

  const acknowledge = async (): Promise<void> => {
    if (await controller.acknowledge()) finish()
  }

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" />
      <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="welcome-notice-title">
        <h2 id="welcome-notice-title" className={css.title}>{t('welcome.title')}</h2>
        <p className={css.lead}>{t('welcome.lead')}</p>
        <div className={css.feedback}>
          <strong>{t('welcome.feedbackTitle')}</strong>
          <p>{t('welcome.feedbackBody')}</p>
        </div>
        <p className={css.closing}>{t('welcome.closing')}</p>
        {state.error === null ? null : <p className={css.error} role="alert">{t('welcome.error')}</p>}
        <div className={css.footer}>
          <p className={css.quote}>{t('welcome.quote')}</p>
          <Button
            variant="primary"
            className={css.primary}
            autoFocus
            disabled={state.status === 'saving'}
            onClick={() => { void acknowledge() }}
          >
            {t('welcome.continue')}
          </Button>
        </div>
      </section>
    </div>
  )
}
