// CodeBlock: one code surface for every consumer — markdown fences, the
// run_code program body, and the details panel's raw args/output — with
// shiki highlighting for the registered grammars and an identical-geometry
// plain fallback for everything else. Shiki emits a single <pre class="shiki">
// tree of nested spans whose colors are --shiki-* custom properties
// (token sheets own the values); it produces no scripts or event handlers,
// so injecting its output is safe by construction.

import { useMemo } from 'react'
import clsx from 'clsx'
import { highlightToHtml } from './highlight.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

export function CodeBlock({ code, lang, className }: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  const html = useMemo(() => highlightToHtml(trimmed, lang), [trimmed, lang])
  if (html === undefined) {
    return (
      <div className={clsx(css.block, className)}>
        <pre className={css.plain}><code>{trimmed}</code></pre>
      </div>
    )
  }
  // eslint-disable-next-line react/no-danger -- shiki's output is a static
  // span tree it generated from `code` (no user HTML passes through), the
  // sanctioned innerHTML consumption path per shiki's own docs.
  return <div className={clsx(css.block, className)} dangerouslySetInnerHTML={{ __html: html }} />
}
