import { useEffect, useId, useRef, useState } from 'react'
import type { PlanModeControlProps } from './index.ts'
import css from './PlanModeControl.module.css'

const labels = {
  default: '默认',
  plan: '计划',
} as const

/** Composer control for the host-confirmed plan target. */
export function PlanModeControl({ useSession, setPlanMode }: PlanModeControlProps) {
  const planMode = useSession(snapshot => snapshot.planMode)
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

  if (planMode === null) return null

  const pending = planMode.pending !== undefined
  const target = planMode.pending ?? planMode.active
  const value = target ? 'plan' : 'default'
  const currentLabel = labels[planMode.active ? 'plan' : 'default']
  const targetLabel = labels[value]
  const label = `${targetLabel}${pending ? ' · 待生效' : ''}`
  const title = pending
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
          disabled={switching}
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
