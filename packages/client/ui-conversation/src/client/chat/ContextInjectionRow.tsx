import { useMemo, useState } from 'react'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
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
  /** Role and producer name projected from the durable source. */
  provenance: ContextMessageNode['provenance']
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * @param props - Durable content, its projected provenance, and the locale seat.
 * @returns A collapsed context row with a bounded JSON body.
 */
export function ContextInjectionRow({ content, source, provenance, t }: ContextInjectionRowProps) {
  const [open, setOpen] = useState(false)
  const body = useMemo(() => {
    if (!open) return ''
    const text = inlineJson({ content, source })
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
      : text
  }, [content, open, source, t])

  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t(provenance.role === 'recall' ? 'message.contextRecall' : 'message.contextInjection')}
      collapsedContent={provenance.label === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.source} data-context-source>{provenance.label}</span>
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <pre className={css.body} data-context-injection-body>{body}</pre>
    </DisclosureRow>
  )
}
