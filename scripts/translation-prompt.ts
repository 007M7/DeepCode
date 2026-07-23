/**
 * Executable renderer and response parser for the committed
 * documentation-translation prompt contract (prompt-v4).
 *
 * The v4 contract: three placeholders (`source_lang`, `target_lang`,
 * `terminology`), whole-document translation, and a three-section response
 * (`<translation>`, `<review>`, `<final>` in order, bare XML tags with raw
 * Markdown bodies). The switcher filename is spelled out by the model from
 * the document itself; the pipeline injects no other repository file.
 */

/** Placeholder names supported by the committed translation prompt. */
export const TRANSLATION_PROMPT_PLACEHOLDERS = ['source_lang', 'target_lang', 'terminology'] as const

type TranslationPromptPlaceholder = (typeof TRANSLATION_PROMPT_PLACEHOLDERS)[number]

/** Languages accepted by the bidirectional prompt. */
type TranslationLanguage = 'English' | 'Chinese'

/** Inputs that vary for one rendered translation request. */
export interface TranslationPromptInput {
  sourceLanguage: TranslationLanguage
  /** Complete current `terminology.md` contents. */
  terminology: string
}

/** Parsed contents of the three-section response. */
export interface TranslationResponse {
  translation: string
  review: string
  final: string
}

const PLACEHOLDER = /{{([a-z_]+)}}/g
const TEMPLATE_OPEN = '## 模板正文\n\n````text\n'
const TEMPLATE_CLOSE = '\n````'
const RESPONSE_SECTIONS = ['translation', 'review', 'final'] as const
const RESPONSE_DELIMITERS = new Set(RESPONSE_SECTIONS.flatMap(section => [`<${section}>`, `</${section}>`]))

/** Extract the machine-consumed text fence from `translation-prompt.md`. */
function extractTranslationPrompt(document: string): string {
  const start = document.indexOf(TEMPLATE_OPEN)
  if (start === -1) throw new Error('translation prompt: missing `## 模板正文` text fence')
  const contentStart = start + TEMPLATE_OPEN.length
  const end = document.indexOf(TEMPLATE_CLOSE, contentStart)
  if (end === -1) throw new Error('translation prompt: missing closing four-backtick fence')
  return document.slice(contentStart, end)
}

/** Read the placeholder names documented in the prompt's contract table. */
export function documentedTranslationPromptPlaceholders(document: string): string[] {
  const preambleEnd = document.indexOf(TEMPLATE_OPEN)
  if (preambleEnd === -1) throw new Error('translation prompt: missing template body')
  return [...document.slice(0, preambleEnd).matchAll(/^\| `{{([a-z_]+)}}` \|/gm)].map(match => match[1] ?? '')
}

/** Render one system prompt from the checked-in template. */
export function renderTranslationPrompt(document: string, input: TranslationPromptInput): string {
  const targetLanguage: TranslationLanguage = input.sourceLanguage === 'English' ? 'Chinese' : 'English'
  const values: Record<TranslationPromptPlaceholder, string> = {
    source_lang: input.sourceLanguage,
    target_lang: targetLanguage,
    terminology: input.terminology,
  }
  const template = extractTranslationPrompt(document)
  const names = [...template.matchAll(PLACEHOLDER)].map(match => match[1] ?? '')
  const unknown = names.filter(name => !TRANSLATION_PROMPT_PLACEHOLDERS.includes(name as TranslationPromptPlaceholder))
  if (unknown.length > 0) throw new Error(`translation prompt: unsupported placeholder(s): ${[...new Set(unknown)].join(', ')}`)
  const missing = TRANSLATION_PROMPT_PLACEHOLDERS.filter(name => !names.includes(name))
  if (missing.length > 0) throw new Error(`translation prompt: template does not use required placeholder(s): ${missing.join(', ')}`)

  return template.replace(PLACEHOLDER, (_token, name: string) => values[name as TranslationPromptPlaceholder])
}

function escapeResponseBody(value: string): string {
  return value.split('\n').map((line) => {
    const delimiter = line.replace(/^\\+/, '')
    return RESPONSE_DELIMITERS.has(delimiter) ? `\\${line}` : line
  }).join('\n')
}

function unescapeResponseBody(value: string): string {
  return value.split('\n').map((line) => {
    if (!line.startsWith('\\')) return line
    const candidate = line.slice(1)
    return RESPONSE_DELIMITERS.has(candidate.replace(/^\\+/, '')) ? candidate : line
  }).join('\n')
}

/** Serialize a response in the exact escaped three-section shape the prompt requests. */
export function renderTranslationResponse(response: TranslationResponse): string {
  return RESPONSE_SECTIONS.map(section => `<${section}>\n${escapeResponseBody(response[section])}\n</${section}>`).join('\n\n')
}

/**
 * Parse the three-section response. Sections must each appear exactly once
 * and in order; escaped delimiter lines in Markdown bodies are restored.
 * A fenced ```xml wrapper around the whole response is tolerated, matching
 * the shape some models echo back from the prompt's own example.
 */
export function parseTranslationResponse(text: string): TranslationResponse {
  let body = text.trim()
  const fenced = /^```(?:xml)?\n([\s\S]*?)\n```$/.exec(body)
  if (fenced?.[1] !== undefined) body = fenced[1].trim()

  const values: Partial<Record<(typeof RESPONSE_SECTIONS)[number], string>> = {}
  const lines = body.split('\n')
  let previousCloseEnd = 0
  for (const [index, section] of RESPONSE_SECTIONS.entries()) {
    const open = `<${section}>`
    const close = `</${section}>`
    const openCount = lines.filter(line => line === open).length
    const closeCount = lines.filter(line => line === close).length
    if (openCount === 0 || closeCount === 0) {
      throw new Error(`translation response: missing or unterminated <${section}> section`)
    }
    if (openCount > 1 || closeCount > 1) throw new Error(`translation response: duplicate <${section}> section`)

    const openStart = body.search(new RegExp(`^<${section}>$`, 'm'))
    const closeStart = body.search(new RegExp(`^</${section}>$`, 'm'))
    const separator = body.slice(previousCloseEnd, openStart)
    if (closeStart < openStart || (index === 0 ? separator !== '' : !/^\n+$/.test(separator))) {
      throw new Error('translation response: sections must appear in translation, review, final order')
    }

    let contentStart = openStart + open.length
    if (body[contentStart] === '\n') contentStart++
    let contentEnd = closeStart
    if (body[contentEnd - 1] === '\n') contentEnd--
    values[section] = unescapeResponseBody(body.slice(contentStart, contentEnd))
    previousCloseEnd = closeStart + close.length
  }
  if (previousCloseEnd !== body.length) throw new Error('translation response: content is not allowed outside response sections')
  return values as TranslationResponse
}
