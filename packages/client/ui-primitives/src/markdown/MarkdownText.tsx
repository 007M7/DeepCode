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

/** Build the component table; while `streaming`, fences render the plain arm (see CodeBlock). */
function buildComponents(streaming: boolean): Components {
  return {
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
    // grammars, identical-geometry plain fallback for unknown/absent
    // languages); inline code keeps the default <code> path (the :not(pre)
    // rule styles it). While the message streams, the fence renders the
    // plain arm — retokenizing a growing fence on every chunk is quadratic
    // main-thread work; the finalize swap highlights it once.
    pre: ({ children }) => {
      // The markdown pipeline always hands `pre` its single `code` element;
      // the undefined arm guards a react-markdown representation change.
      /* v8 ignore next 2 */
      const child = isValidElement<{ className?: string; children?: unknown }>(children) ? children : undefined
      const raw = child?.props.children
      // A fence whose content isn't one plain string (e.g. an empty fence)
      // keeps the stock <pre> rather than guessing.
      if (typeof raw !== 'string') return <pre>{children}</pre>
      const lang = /language-([\w-]+)/.exec(child?.props.className ?? '')?.[1]
      return <CodeBlock code={raw} lang={streaming ? undefined : lang} />
    },
  }
}

const staticComponents = buildComponents(false)
const streamingComponents = buildComponents(true)

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection;
 * `streaming` renders fences plain (highlighting lands on the finalize swap).
 * @returns A GFM document with raw HTML, relative links, unsafe protocols, and remote images disabled.
 */
export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={css.markdown}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={streaming ? streamingComponents : staticComponents}
        urlTransform={safeUrl}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
