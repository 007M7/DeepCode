import { isValidElement } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock.tsx'
import css from './MarkdownText.module.css'

const remarkPlugins = [remarkGfm]

function sanitizeUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url
      default:
        return ''
    }
  } catch {
    return ''
  }
}

const safeUrl: UrlTransform = url => sanitizeUrl(url)

const components: Components = {
  a: ({ href = '', children }) => {
    const safeHref = sanitizeUrl(href)
    if (safeHref === '') return <>{children}</>
    const external = ['http:', 'https:'].includes(new URL(safeHref).protocol)
    return (
      <a
        href={safeHref}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    )
  },
  img: ({ alt = '' }) => <span className={css.imageAlt}>{alt}</span>,
  table: ({ children }) => (
    <div className={css.tableScroll}>
      <table>{children}</table>
    </div>
  ),
  // Fenced blocks route through the shared CodeBlock (shiki for registered
  // grammars, identical-geometry plain fallback for unknown/absent languages);
  // inline code keeps the default <code> path (the :not(pre) rule styles it).
  pre: ({ children }) => {
    const child = isValidElement<{ className?: string; children?: unknown }>(children) ? children : undefined
    const raw = child?.props.children
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : undefined
    // A fence whose content isn't one plain string (never produced by the
    // markdown pipeline) keeps the stock <pre> rather than guessing.
    if (text === undefined) return <pre>{children}</pre>
    const lang = /language-([\w-]+)/.exec(child?.props.className ?? '')?.[1]
    return <CodeBlock code={text} lang={lang} />
  },
}

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection.
 * @returns A GFM document with raw HTML, relative links, unsafe protocols, and remote images disabled.
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className={css.markdown}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={safeUrl}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
