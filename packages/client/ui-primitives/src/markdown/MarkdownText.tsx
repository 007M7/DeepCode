import ReactMarkdown from 'react-markdown'
import type { Components, UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
