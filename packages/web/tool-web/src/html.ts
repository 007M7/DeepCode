/**
 * Minimal, dependency-free HTML→markdown-ish text conversion for `web_fetch`
 * presentation. This is intentionally NOT a full HTML parser: it strips
 * script/style/noscript, drops tags, decodes the common named/numeric entities,
 * and collapses whitespace into a readable plain-text approximation with a few
 * markdown affordances (headings, list bullets, links). A heavier converter can
 * replace this without touching the seam or the tool schema.
 *
 * @module @deepseek-ai/dsh-tool-web/html
 */

/** Decode the handful of HTML entities common in textual content. */
function decodeEntities(text: string): string {
  return text
    .replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16)
        return safeFromCodePoint(code, match)
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10)
        return safeFromCodePoint(code, match)
      }
      return NAMED_ENTITIES[entity] ?? match
    })
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    // An out-of-range code point (RangeError) is the only failure here; keep the
    // original entity text rather than throwing out of pure presentation.
    return fallback
  }
}

/**
 * Convert an HTML document to a readable markdown-ish text approximation.
 * Best-effort and lossy by design — fidelity is the job of a future heavier
 * converter, not this fallback.
 */
export function htmlToMarkdown(html: string): string {
  let text = html
    // Drop non-content elements entirely (including their contents).
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Convert links to markdown before stripping tags.
  text = text.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim()
    return cleanLabel.length > 0 ? `[${cleanLabel}](${href})` : href
  })

  // Headings → markdown hashes.
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, body: string) => {
    const hashes = '#'.repeat(Number(level))
    return `\n\n${hashes} ${body.replace(/<[^>]+>/g, '').trim()}\n\n`
  })

  // List items → bullets.
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, body: string) => `\n- ${body.replace(/<[^>]+>/g, '').trim()}`)

  // Block-level breaks become paragraph breaks.
  text = text
    .replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')

  // Drop all remaining tags, decode entities, collapse whitespace.
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  text = text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}
