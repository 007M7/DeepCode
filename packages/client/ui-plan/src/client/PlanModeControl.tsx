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
 * Read-only status badge over the host-computed `plan` projection. Plan mode
 * is entered through the /plan command only; the chip appears while the
 * effective target is plan mode and its hover × executes /plan off. The
 * displayed state follows the target (`pending ? !active : active`) — a
 * folded host value, not client optimism, so an arriving frame corrects it.
 */
export function PlanChip({ useProjection, locked, exitPlanMode }: PlanChipProps) {
  const plan = useProjection('plan')
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Absent capability (no plan-mode host plugin / no session yet) or the
  // default mode: no seat content.
  if (plan === undefined) return null
  const target = plan.pending ? !plan.active : plan.active
  if (!target) return null

  const off = (): void => {
    // No leaving/locked guard: both disable the button, so no click arrives.
    setLeaving(true)
    setError(null)
    void exitPlanMode().then((failure) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.chip}
        aria-label="Plan mode on, press to turn off"
        title="Plan mode on — click × to turn off (/plan off)"
        disabled={locked || leaving}
        onClick={off}
      >
        Plan
        <span className={css.close} aria-hidden>
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </span>
      </button>
      {error !== null && <span className={css.error} role="status" title={error}>退出 plan mode 失败</span>}
    </span>
  )
}
