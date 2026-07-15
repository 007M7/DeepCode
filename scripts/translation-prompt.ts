/**
 * Executable renderer and strict response parser for the committed
 * documentation-translation prompt contract.
 */

import { basename } from 'node:path'
import { SaxesParser } from 'saxes'

/** Placeholder names supported by the committed translation prompt. */
export const TRANSLATION_PROMPT_PLACEHOLDERS = [
  'source_lang',
  'target_lang',
  'translation_rules',
  'terminology',
  'source_filename',
  'source_filename_zh',
] as const

type TranslationPromptPlaceholder = (typeof TRANSLATION_PROMPT_PLACEHOLDERS)[number]

/** Languages accepted by the bidirectional prompt. */
type TranslationLanguage = 'English' | 'Chinese'

/** Inputs that vary for one rendered translation request. */
export interface TranslationPromptInput {
  sourceLanguage: TranslationLanguage
  /** Source basename, including `.md` or `.zh.md`. */
  sourceFilename: string
  /** Complete current `translation-rules.md` contents. */
  translationRules: string
  /** Complete current `terminology.md` contents. */
  terminology: string
}

/** Parsed contents of the three-element XML response. */
export interface TranslationResponse {
  translation: string
  review: string
  final: string
}

const PLACEHOLDER = /{{([a-z_]+)}}/g
const TEMPLATE_OPEN = '## 模板正文\n\n````text\n'
const TEMPLATE_CLOSE = '\n````'
const RESPONSE_CHILDREN = ['translation', 'review', 'final'] as const

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

/** Render one system prompt from the checked-in template and canonical rules. */
export function renderTranslationPrompt(document: string, input: TranslationPromptInput): string {
  if (basename(input.sourceFilename) !== input.sourceFilename) {
    throw new Error(`translation prompt: sourceFilename must be a basename; got ${JSON.stringify(input.sourceFilename)}`)
  }
  const sourceIsChinese = input.sourceFilename.endsWith('.zh.md')
  if (input.sourceLanguage === 'Chinese' ? !sourceIsChinese : sourceIsChinese || !input.sourceFilename.endsWith('.md')) {
    throw new Error(`translation prompt: ${input.sourceFilename} does not match source language ${input.sourceLanguage}`)
  }

  const targetLanguage: TranslationLanguage = input.sourceLanguage === 'English' ? 'Chinese' : 'English'
  const sourceFilenameZh = sourceIsChinese ? input.sourceFilename : input.sourceFilename.replace(/\.md$/, '.zh.md')
  const values: Record<TranslationPromptPlaceholder, string> = {
    source_lang: input.sourceLanguage,
    target_lang: targetLanguage,
    translation_rules: input.translationRules,
    terminology: input.terminology,
    source_filename: input.sourceFilename,
    source_filename_zh: sourceFilenameZh,
  }
  const template = extractTranslationPrompt(document)
  const placeholderFreeTemplate = template.replace(PLACEHOLDER, '')
  if (placeholderFreeTemplate.includes('{{') || placeholderFreeTemplate.includes('}}')) {
    throw new Error('translation prompt: template contains malformed placeholder syntax')
  }
  const names = [...template.matchAll(PLACEHOLDER)].map(match => match[1] ?? '')
  const unknown = names.filter(name => !TRANSLATION_PROMPT_PLACEHOLDERS.includes(name as TranslationPromptPlaceholder))
  if (unknown.length > 0) throw new Error(`translation prompt: unsupported placeholder(s): ${[...new Set(unknown)].join(', ')}`)
  const missing = TRANSLATION_PROMPT_PLACEHOLDERS.filter(name => !names.includes(name))
  if (missing.length > 0) throw new Error(`translation prompt: template does not use required placeholder(s): ${missing.join(', ')}`)

  return template.replace(PLACEHOLDER, (_token, name: string) => values[name as TranslationPromptPlaceholder])
}

/** Escape one value so it remains byte-identical inside an XML CDATA field. */
function escapeTranslationCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>')
}

/** Serialize a response using the exact XML wire contract in the prompt. */
export function renderTranslationResponse(response: TranslationResponse): string {
  return [
    '<dsh-translation-response version="1">',
    `<translation><![CDATA[${escapeTranslationCdata(response.translation)}]]></translation>`,
    `<review><![CDATA[${escapeTranslationCdata(response.review)}]]></review>`,
    `<final><![CDATA[${escapeTranslationCdata(response.final)}]]></final>`,
    '</dsh-translation-response>',
  ].join('\n')
}

/** Parse and validate the exact XML response shape emitted by the model. */
export function parseTranslationResponse(xml: string): TranslationResponse {
  const values: TranslationResponse = { translation: '', review: '', final: '' }
  const stack: string[] = []
  const cdataFields = new Set<string>()
  let rootSeen = false
  let childIndex = 0
  const fail = (message: string): never => {
    throw new Error(`translation response: ${message}`)
  }
  const parser = new SaxesParser({ xmlns: false })

  parser.on('opentag', (tag) => {
    if (stack.length === 0) {
      if (rootSeen) fail('contains more than one root element')
      if (tag.name !== 'dsh-translation-response') fail(`expected dsh-translation-response root, got ${tag.name}`)
      const attributes = Object.keys(tag.attributes)
      if (attributes.length !== 1 || tag.attributes.version !== '1') fail('root must have only version="1"')
      rootSeen = true
    } else if (stack.length === 1) {
      const expected = RESPONSE_CHILDREN[childIndex]
      if (tag.name !== expected) fail(`expected ${expected ?? 'no more children'}, got ${tag.name}`)
      if (Object.keys(tag.attributes).length !== 0) fail(`${tag.name} must not have attributes`)
      childIndex++
    } else {
      fail(`nested element ${tag.name} is not allowed`)
    }
    stack.push(tag.name)
  })
  parser.on('text', (value) => {
    if (stack.length <= 1 && value.trim() === '') return
    fail('all response field content must be inside CDATA')
  })
  parser.on('cdata', (value) => {
    const field = stack.at(-1)
    if (field === undefined || !RESPONSE_CHILDREN.includes(field as (typeof RESPONSE_CHILDREN)[number])) {
      fail('CDATA is allowed only inside translation, review, or final')
    }
    const key = field as (typeof RESPONSE_CHILDREN)[number]
    values[key] += value
    cdataFields.add(key)
  })
  parser.on('closetag', (tag) => {
    const expected = stack.pop()
    if (expected !== tag.name) fail(`closing ${tag.name} does not match ${expected ?? 'nothing'}`)
  })
  parser.on('comment', () => fail('comments are not allowed'))
  parser.on('doctype', () => fail('doctypes are not allowed'))
  parser.on('processinginstruction', () => fail('processing instructions are not allowed'))
  parser.on('error', error => fail(`invalid XML: ${error.message}`))
  parser.write(xml).close()

  if (childIndex !== RESPONSE_CHILDREN.length) fail('translation, review, and final must each appear exactly once and in order')
  for (const field of RESPONSE_CHILDREN) {
    if (!cdataFields.has(field)) fail(`${field} must contain a CDATA section`)
  }
  return values
}
