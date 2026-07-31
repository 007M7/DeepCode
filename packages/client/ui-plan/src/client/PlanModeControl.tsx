import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanChipInjected } from './index.ts'
import css from './PlanModeControl.module.css'

/** Full plan-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type PlanChipProps =
  PropsRuntime<'conversation.input.plan'> & InjectFace<PlanChipInjected> & PropsLocale<'plan'>

/**
 * Plan-mode toggle over the host-computed `plan` projection. The chip renders
 * whenever the capability is present and reflects the effective target as its
 * pressed state (`pending ? !active : active` — a folded host value, not
 * client optimism, so an arriving frame corrects it). Clicking executes
 * /plan or /plan off toward the opposite target.
 */
export function PlanChip({ useProjection, locked, setPlanMode, t }: PlanChipProps) {
  const plan = useProjection('plan')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Absent capability (no plan-mode host plugin / no session yet): no seat
  // content — without the capability there is nothing to toggle.
  if (plan === undefined) return null
  const target = plan.pending ? !plan.active : plan.active

  const toggle = (): void => {
    // No busy/locked guard: both disable the button, so no click arrives.
    // Failure copy stays English (error-surface policy: not localized).
    const on = !target
    const failText = on ? 'failed to enter plan mode' : 'failed to exit plan mode'
    setBusy(true)
    setError(null)
    void setPlanMode(on).then((failure) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(failure === null ? null : { text: failText, detail: failure })
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError({ text: failText, detail: reason instanceof Error ? reason.message : String(reason) })
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.chip}
        aria-pressed={target}
        aria-label={target ? t('chip.on.aria') : t('chip.off.aria')}
        title={target ? t('chip.on.title') : t('chip.off.title')}
        disabled={locked || busy}
        onClick={toggle}
      >
        {/* Design literal, not copy: the chip wordmark stays 'Plan on/off' in every locale. */}
        Plan { target ? 'on' : 'off' }
      </button>
      {error !== null && <span className={css.error} role="status" title={error.detail}>{error.text}</span>}
    </span>
  )
}
