// Minimal, dependency-free Markdown → DOM renderer for in-stream artifact
// previews (张子雅's "把 md 文档在流里展示出来" request). Deliberately NOT a
// full CommonMark implementation — it covers the constructs that show up in
// agent-authored .md artifacts (headings, emphasis, inline code, fenced code,
// lists, blockquotes, links, paragraphs, horizontal rules) and nothing else.
//
// SECURITY CONTRACT (the whole reason this file exists instead of `marked`):
//   The renderer NEVER interprets HTML. Every scrap of model-authored text
//   reaches the DOM through document.createTextNode / .textContent only — so a
//   literal `<script>` or `<img onerror=…>` inside the markdown renders as the
//   visible characters "<script>…", never as a node. There is no innerHTML
//   path anywhere below. Links are the one interactive affordance: an <a> is
//   created ONLY for http(s)/mailto hrefs, its navigation is cancelled
//   (preventDefault) and handed to the caller's onLink() — which routes through
//   the shell:openExternal whitelist. Any other scheme (javascript:, data:, …)
//   degrades to inert text.
//
// Public API (window.__dshMdMini / module.exports):
//   parseBlocks(src)          → { blocks, truncated }   (pure, testable)
//   parseInline(text)         → token[]                 (pure, testable)
//   render(src, opts)         → HTMLElement             (opts.document, opts.onLink)
//   MAX_LINES                 → number                  (preview length cap)

'use strict'

;(function () {
  // Preview cap: agent artifacts can be thousands of lines; the in-stream card
  // is a peek, not a reader. Past this we stop and show an "open full" note.
  const MAX_LINES = 200

  // ---- block-level parse ---------------------------------------------------

  const RE_FENCE = /^(`{3,}|~{3,})(.*)$/
  const RE_FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/
  const RE_HEADING = /^(#{1,6})\s+(.*)$/
  const RE_LIST = /^\s*([-*+]|\d+[.)])\s+/
  const RE_LIST_ORDERED = /^\s*\d+[.)]\s+/
  const RE_QUOTE = /^\s*>\s?/
  const RE_HR = /^\s*([-*_])\1{2,}\s*$/
  const RE_BLANK = /^\s*$/

  function isBlockStart(line) {
    return (
      RE_BLANK.test(line) ||
      RE_FENCE.test(line) ||
      RE_HEADING.test(line) ||
      RE_LIST.test(line) ||
      RE_QUOTE.test(line) ||
      RE_HR.test(line)
    )
  }

  function parseBlocks(src) {
    const allLines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')
    const truncated = allLines.length > MAX_LINES
    const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines
    const blocks = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      if (RE_BLANK.test(line)) {
        i++
        continue
      }

      // Fenced code block — content is captured verbatim (no inline parse).
      const fence = RE_FENCE.exec(line)
      if (fence) {
        const fenceCh = fence[1][0]
        const lang = fence[2].trim()
        const code = []
        i++
        while (i < lines.length) {
          const close = RE_FENCE_CLOSE.exec(lines[i])
          if (close && close[1][0] === fenceCh) {
            i++
            break
          }
          code.push(lines[i])
          i++
        }
        blocks.push({ type: 'code', lang, text: code.join('\n') })
        continue
      }

      const heading = RE_HEADING.exec(line)
      if (heading) {
        blocks.push({
          type: 'heading',
          level: heading[1].length,
          text: heading[2].replace(/\s+#+\s*$/, '').trim(),
        })
        i++
        continue
      }

      // Horizontal rule (checked before list so `***`/`---` don't parse as a
      // bullet item with empty content).
      if (RE_HR.test(line)) {
        blocks.push({ type: 'hr' })
        i++
        continue
      }

      // List — gather consecutive items of the SAME ordered/unordered flavour.
      if (RE_LIST.test(line)) {
        const ordered = RE_LIST_ORDERED.test(line)
        const items = []
        while (i < lines.length && RE_LIST.test(lines[i]) && !RE_HR.test(lines[i])) {
          if (RE_LIST_ORDERED.test(lines[i]) !== ordered) break
          items.push(lines[i].replace(RE_LIST, ''))
          i++
        }
        blocks.push({ type: 'list', ordered, items })
        continue
      }

      // Blockquote — one level, consecutive `>` lines merged into one text.
      if (RE_QUOTE.test(line)) {
        const buf = []
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          buf.push(lines[i].replace(RE_QUOTE, ''))
          i++
        }
        blocks.push({ type: 'quote', text: buf.join(' ') })
        continue
      }

      // Paragraph — run of non-blank, non-block-start lines joined by spaces.
      const para = [line]
      i++
      while (i < lines.length && !isBlockStart(lines[i])) {
        para.push(lines[i])
        i++
      }
      blocks.push({ type: 'paragraph', text: para.join(' ') })
    }

    return { blocks, truncated }
  }

  // ---- inline parse --------------------------------------------------------
  // Scanning tokenizer. At each position we try the inline constructs in
  // precedence order; anything else accumulates into a plain-text token. The
  // token list is flat, but strong/em/link inner text is re-parsed at build
  // time so `**bold `code`**` nests correctly.

  const RE_CODE = /^(`+)([\s\S]*?)\1/
  const RE_LINK = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/

  function parseInline(text) {
    const s = String(text == null ? '' : text)
    const tokens = []
    let buf = ''
    const flush = () => {
      if (buf) {
        tokens.push({ type: 'text', text: buf })
        buf = ''
      }
    }
    let i = 0

    while (i < s.length) {
      const c = s[i]
      const tail = s.slice(i)

      // Inline code: backtick-delimited, verbatim, highest precedence so
      // markup inside a code span stays literal.
      if (c === '`') {
        const m = RE_CODE.exec(tail)
        if (m) {
          flush()
          tokens.push({ type: 'code', text: m[2] })
          i += m[0].length
          continue
        }
      }

      // Link [text](href) — href stops at whitespace/`)`; optional "title" dropped.
      if (c === '[') {
        const m = RE_LINK.exec(tail)
        if (m) {
          flush()
          tokens.push({ type: 'link', text: m[1], href: m[2] })
          i += m[0].length
          continue
        }
      }

      // Strong (**/__) then emphasis (*/_).
      if (c === '*' || c === '_') {
        const pair = c + c
        if (tail.slice(0, 2) === pair) {
          const strongRe = new RegExp('^\\' + c + '\\' + c + '([\\s\\S]+?)\\' + c + '\\' + c)
          const m = strongRe.exec(tail)
          if (m) {
            flush()
            tokens.push({ type: 'strong', text: m[1] })
            i += m[0].length
            continue
          }
        }
        // Emphasis: require a non-space, non-delimiter char right after the
        // marker so `a * b` and bare `*` don't open a run.
        const emRe = new RegExp('^\\' + c + '(?![\\s' + '\\' + c + '])([\\s\\S]*?)\\' + c)
        const m = emRe.exec(tail)
        if (m && m[1].trim()) {
          flush()
          tokens.push({ type: 'em', text: m[1] })
          i += m[0].length
          continue
        }
      }

      buf += c
      i++
    }

    flush()
    return tokens
  }

  function isSafeHref(href) {
    return /^(https?:|mailto:)/i.test(String(href).trim())
  }

  // ---- DOM build -----------------------------------------------------------

  function buildInline(parent, tokens, doc, onLink) {
    for (const t of tokens) {
      if (t.type === 'text') {
        parent.appendChild(doc.createTextNode(t.text))
      } else if (t.type === 'code') {
        const el = doc.createElement('code')
        el.className = 'md-mini-code'
        el.textContent = t.text
        parent.appendChild(el)
      } else if (t.type === 'strong') {
        const el = doc.createElement('strong')
        buildInline(el, parseInline(t.text), doc, onLink)
        parent.appendChild(el)
      } else if (t.type === 'em') {
        const el = doc.createElement('em')
        buildInline(el, parseInline(t.text), doc, onLink)
        parent.appendChild(el)
      } else if (t.type === 'link') {
        if (isSafeHref(t.href)) {
          const a = doc.createElement('a')
          a.className = 'md-mini-link'
          a.textContent = t.text || t.href
          a.setAttribute('href', t.href)
          a.setAttribute('rel', 'noreferrer noopener')
          a.addEventListener('click', (ev) => {
            if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
            if (onLink) onLink(t.href)
          })
          parent.appendChild(a)
        } else {
          // Disallowed scheme (javascript:, data:, …): render the visible text
          // inert. No node that could navigate is ever created.
          parent.appendChild(doc.createTextNode(t.text || t.href))
        }
      }
    }
  }

  function render(src, opts) {
    opts = opts || {}
    const doc = opts.document || (typeof document !== 'undefined' ? document : null)
    if (!doc) throw new Error('md-mini.render: no document available')
    const onLink = typeof opts.onLink === 'function' ? opts.onLink : null

    const parsed = parseBlocks(src)
    const root = doc.createElement('div')
    root.className = 'md-mini'

    for (const b of parsed.blocks) {
      if (b.type === 'heading') {
        const el = doc.createElement('h' + b.level)
        el.className = 'md-mini-h md-mini-h' + b.level
        buildInline(el, parseInline(b.text), doc, onLink)
        root.appendChild(el)
      } else if (b.type === 'paragraph') {
        const el = doc.createElement('p')
        el.className = 'md-mini-p'
        buildInline(el, parseInline(b.text), doc, onLink)
        root.appendChild(el)
      } else if (b.type === 'code') {
        const pre = doc.createElement('pre')
        pre.className = 'md-mini-pre'
        const code = doc.createElement('code')
        if (b.lang) code.className = 'md-mini-lang-' + b.lang.replace(/[^\w-]/g, '')
        code.textContent = b.text
        pre.appendChild(code)
        root.appendChild(pre)
      } else if (b.type === 'list') {
        const listEl = doc.createElement(b.ordered ? 'ol' : 'ul')
        listEl.className = 'md-mini-list'
        for (const item of b.items) {
          const li = doc.createElement('li')
          buildInline(li, parseInline(item), doc, onLink)
          listEl.appendChild(li)
        }
        root.appendChild(listEl)
      } else if (b.type === 'quote') {
        const q = doc.createElement('blockquote')
        q.className = 'md-mini-quote'
        buildInline(q, parseInline(b.text), doc, onLink)
        root.appendChild(q)
      } else if (b.type === 'hr') {
        const hr = doc.createElement('hr')
        hr.className = 'md-mini-hr'
        root.appendChild(hr)
      }
    }

    if (parsed.truncated) {
      const note = doc.createElement('div')
      note.className = 'md-mini-truncated'
      note.textContent = '仅预览前 ' + MAX_LINES + ' 行 · 用「在浏览器打开」查看全文'
      root.appendChild(note)
    }

    return root
  }

  const API = { parseBlocks, parseInline, render, isSafeHref, MAX_LINES }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.__dshMdMini = API
})()
