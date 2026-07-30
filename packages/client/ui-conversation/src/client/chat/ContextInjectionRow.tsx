import { useMemo, useState } from 'react'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { DisclosureRow } from './DisclosureRow.tsx'
import css from './ContextInjectionRow.module.css'

const MAX_CHARS = 20_000

function inlineJson(payload: unknown): string {
  const raw = JSON.stringify(payload)
  let formatted = ''
  let quoted = false
  let escaped = false

  for (let index = 0; index < raw.length; index++) {
    const char = raw.charAt(index)
    if (quoted) {
      formatted += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      formatted += char
      continue
    }
    if (char === '{' || char === '[') {
      formatted += char
      const close = char === '{' ? '}' : ']'
      if (raw[index + 1] !== close) formatted += ' '
      continue
    }
    if (char === '}' || char === ']') {
      const open = char === '}' ? '{' : '['
      if (raw[index - 1] !== open) formatted += ' '
      formatted += char
      continue
    }
    formatted += char === ':' || char === ',' ? `${char} ` : char
  }
  return formatted
}

/** Props for the logged non-user message presentation. */
export interface ContextInjectionRowProps {
  content: ContextMessageNode['content']
  source: ContextMessageNode['source']
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 * @param props - Durable content and source provenance.
 * @returns A collapsed context row with a bounded JSON body.
 */
export function ContextInjectionRow({ content, source }: ContextInjectionRowProps) {
  const [open, setOpen] = useState(false)
  const body = useMemo(() => {
    if (!open) return ''
    const text = inlineJson({ content, source })
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n… 已截断，共 ${text.length} 字符`
      : text
  }, [content, open, source])

  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title="上下文注入"
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <pre className={css.body} data-context-injection-body>{body}</pre>
    </DisclosureRow>
  )
}
