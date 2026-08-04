import { isValidElement, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, UrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from './CodeBlock.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

const streamingRemarkPlugins = [remarkGfm]
const settledRemarkPlugins = [remarkGfm, remarkMath]
const settledRehypePlugins = [rehypeKatex]

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

/** Copy-button labels forwarded to fence CodeBlocks (this package is cordis-free, so copy arrives via props). */
export interface MarkdownCodeLabels {
  /** Copy-button idle label. */
  copyLabel?: string | undefined
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel?: string | undefined
}

function remoteImageUrl(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Build the component table; while `streaming`, fences render the plain arm (see CodeBlock). */
function buildComponents(streaming: boolean, codeLabels?: MarkdownCodeLabels): Components {
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
    img: ({ alt = '', src = '' }) => {
      const imageSrc = remoteImageUrl(src)
      if (imageSrc === undefined) return <span className={css.imageAlt}>{alt}</span>
      return (
        <img
          className={css.image}
          src={imageSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      )
    },
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
      return (
        <CodeBlock
          code={raw}
          lang={streaming ? undefined : lang}
          copyLabel={codeLabels?.copyLabel}
          copiedLabel={codeLabels?.copiedLabel}
        />
      )
    },
  }
}

const staticComponents = buildComponents(false)
const streamingComponents = buildComponents(true)

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection;
 * `streaming` renders fences and TeX plain (highlighting and KaTeX land on the finalize swap);
 * `codeLabels` forwards localized copy-button labels to fence CodeBlocks —
 * pass a reference-stable object (memoized per locale revision), because the
 * component table memoizes on its identity and a fresh literal per render
 * would rebuild it every streaming chunk.
 * @returns A GFM document with TeX math rendered through KaTeX; raw HTML,
 * relative links, and unsafe protocols are disabled, while absolute HTTP(S)
 * images render directly.
 */
export function MarkdownText({ text, streaming = false, codeLabels }: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
}) {
  // The label-free tables stay module-level singletons so the common case
  // keeps referential stability across renders without a hook.
  const components = useMemo(() => {
    if (codeLabels === undefined) return streaming ? streamingComponents : staticComponents
    return buildComponents(streaming, codeLabels)
  }, [streaming, codeLabels])
  return (
    <div className={css.markdown}>
      <ReactMarkdown
        remarkPlugins={streaming ? streamingRemarkPlugins : settledRemarkPlugins}
        rehypePlugins={streaming ? undefined : settledRehypePlugins}
        components={components}
        urlTransform={safeUrl}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
