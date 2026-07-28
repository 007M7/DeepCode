import { useEffect, useId, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.plan seat and
// its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanModeControlInjected } from './index.ts'
import css from './PlanModeControl.module.css'

/** Full plan-seat component props: runtime share (standard kit + locked owner prop) & injected share. */
export type PlanModeControlProps =
  PropsRuntime<'conversation.input.plan'> & InjectFace<PlanModeControlInjected>

const labels = {
  default: '默认',
  plan: '计划',
} as const

/** Composer control over the host-computed `plan` projection. */
export function PlanModeControl({ useProjection, locked, setPlanMode }: PlanModeControlProps) {
  const plan = useProjection('plan')
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const descriptionId = useId()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Capability absence: the host composed no plan-mode plugin (or no
  // baseline has arrived yet) — the seat stays empty.
  if (plan === undefined) return null

  const target = plan.pending ? !plan.active : plan.active
  const value = target ? 'plan' : 'default'
  const currentLabel = labels[plan.active ? 'plan' : 'default']
  const targetLabel = labels[value]
  const label = `${targetLabel}${plan.pending ? ' · 待生效' : ''}`
  const title = plan.pending
    ? `当前为${currentLabel}模式；${targetLabel}模式将在下一次模型请求时生效`
    : `当前为${currentLabel}模式`

  const select = (active: boolean): void => {
    if (active === target || switching) return
    setSwitching(true)
    setError(null)
    void setPlanMode(active).then((failure) => {
      if (!aliveRef.current) return
      setSwitching(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setSwitching(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <label className={css.root} title={title}>
        <span className={css.chip}>
          {label}
          <svg className={css.chevron} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </span>
        <span id={descriptionId} className={css.description}>{title}</span>
        <select
          className={css.select}
          aria-label="协作模式"
          aria-describedby={descriptionId}
          value={value}
          disabled={locked || switching}
          onChange={(event) => { select(event.target.value === 'plan') }}
        >
          <option value="default">默认</option>
          <option value="plan">计划</option>
        </select>
      </label>
      {error !== null && <span className={css.error} role="status" title={error}>模式切换失败</span>}
    </span>
  )
}
