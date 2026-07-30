import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanChipInjected } from './index.ts'
import css from './PlanModeControl.module.css'

/** Full plan-seat component props: runtime share (standard kit + locked owner prop) & injected share. */
export type PlanChipProps =
  PropsRuntime<'conversation.input.plan'> & InjectFace<PlanChipInjected>

/**
 * Plan-mode toggle over the host-computed `plan` projection. The chip renders
 * whenever the capability is present and reflects the effective target as its
 * pressed state (`pending ? !active : active` — a folded host value, not
 * client optimism, so an arriving frame corrects it). Clicking executes
 * /plan or /plan off toward the opposite target.
 */
export function PlanChip({ useProjection, locked, setPlanMode }: PlanChipProps) {
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
    const on = !target
    const failText = on ? '进入 plan mode 失败' : '退出 plan mode 失败'
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
        aria-label={target ? 'Plan mode on, press to turn off' : 'Plan mode off, press to turn on'}
        title={target
          ? 'Plan mode on — click to turn off (/plan off)'
          : 'Plan mode off — click to turn on (/plan)'}
        disabled={locked || busy}
        onClick={toggle}
      >
        Plan { target ? 'on' : 'off' }
      </button>
      {error !== null && <span className={css.error} role="status" title={error.detail}>{error.text}</span>}
    </span>
  )
}
