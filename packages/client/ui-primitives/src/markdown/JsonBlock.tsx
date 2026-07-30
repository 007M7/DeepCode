// JsonBlock: accessible JSON disclosure row (conversation side; independent
// from the RPC panel's PayloadJson to avoid cross-panel coupling).

import { useMemo, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../icons/index.tsx'
import css from './JsonBlock.module.css'

const MAX_CHARS = 20_000

/** Props for the compact JSON disclosure used in conversation content. */
export interface JsonBlockProps {
  label: string
  payload: unknown
  defaultOpen?: boolean
  /** Semantic glyph shown while collapsed; hover previews the disclosure chevron. */
  collapsedIcon?: ReactNode
}

/** Render a bounded, pretty-printed JSON disclosure. */
export function JsonBlock({
  label,
  payload,
  defaultOpen = false,
  collapsedIcon,
}: JsonBlockProps) {
  const [open, setOpen] = useState(defaultOpen)
  const body = useMemo(() => {
    if (!open) return ''
    let s: string
    try {
      // lib typing hides stringify's undefined arm (undefined/function/symbol payloads).
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      s = JSON.stringify(payload, null, 2) ?? String(payload)
    } catch {
      s = String(payload)
    }
    return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… 已截断，共 ${s.length} 字符` : s
  }, [open, payload])
  const leading = open
    ? <IconChevronDownOutline14 />
    : collapsedIcon === undefined
      ? <IconChevronRightOutline14 />
      : (
        <>
          <span className={css.iconIdle}>{collapsedIcon}</span>
          <IconChevronRightOutline14 className={css.chevronHover} />
        </>
      )
  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        <span className={css.leading} aria-hidden="true">{leading}</span>
        <span>{label}</span>
      </button>
      {open && <pre className={css.body}>{body}</pre>}
    </div>
  )
}
