// JsonBlock: collapsible JSON block (conversation side; independent from the RPC panel's PayloadJson to avoid cross-panel coupling).

import { useMemo, useState } from 'react'
import css from './JsonBlock.module.css'

const MAX_CHARS = 20_000

export function JsonBlock({ label, payload, defaultOpen = false }: {
  label: string
  payload: unknown
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const body = useMemo(() => {
    if (!open) return ''
    let s: string
    try {
      s = JSON.stringify(payload, null, 2) ?? String(payload)
    } catch {
      s = String(payload)
    }
    return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… 已截断，共 ${s.length} 字符` : s
  }, [open, payload])
  return (
    <div className={css.root}>
      <button type="button" className={css.toggle} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className={css.body}>{body}</pre>}
    </div>
  )
}
