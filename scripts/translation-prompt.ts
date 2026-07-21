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

/** Serialize a response in the exact three-section shape the prompt requests. */
export function renderTranslationResponse(response: TranslationResponse): string {
  return RESPONSE_SECTIONS.map(section => `<${section}>\n${response[section]}\n</${section}>`).join('\n\n')
}

/**
 * Parse the three-section response. Sections must each appear exactly once
 * and in order; bodies are raw Markdown taken verbatim between the tags.
 * A fenced ```xml wrapper around the whole response is tolerated, matching
 * the shape some models echo back from the prompt's own example.
 *
 * Section close tags are matched at line starts (the wire shape the prompt
 * example establishes), so a tag mentioned inline in translated prose does
 * not terminate its section early.
 */
export function parseTranslationResponse(text: string): TranslationResponse {
  let body = text.trim()
  const fenced = /^```(?:xml)?\n([\s\S]*?)\n```$/.exec(body)
  if (fenced?.[1] !== undefined) body = fenced[1].trim()

  const values: Partial<Record<(typeof RESPONSE_SECTIONS)[number], string>> = {}
  for (const section of RESPONSE_SECTIONS) {
    const pattern = new RegExp(`^<${section}>\\n?([\\s\\S]*?)\\n?^</${section}>$`, 'gm')
    const first = pattern.exec(body)
    if (first?.[1] === undefined) throw new Error(`translation response: missing or unterminated <${section}> section`)
    if (pattern.exec(body) !== null) throw new Error(`translation response: duplicate <${section}> section`)
    values[section] = first[1]
  }
  const order = RESPONSE_SECTIONS.map(section => body.search(new RegExp(`^<${section}>`, 'm')))
  if (!(order[0]! < order[1]! && order[1]! < order[2]!)) {
    throw new Error('translation response: sections must appear in translation, review, final order')
  }
  return values as TranslationResponse
}
