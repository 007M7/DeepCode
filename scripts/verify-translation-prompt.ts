/** Verify that the committed translation prompt renders and parses as documented. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  documentedTranslationPromptPlaceholders,
  parseTranslationResponse,
  renderTranslationPrompt,
  renderTranslationResponse,
  TRANSLATION_PROMPT_PLACEHOLDERS,
} from './translation-prompt.ts'

const root = resolve(import.meta.dirname, '..')

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

try {
  const document = read('docs/i18n/translation-prompt.md')
  const translationRules = read('docs/i18n/translation-rules.md')
  const terminology = read('docs/i18n/terminology.md')
  const documented = documentedTranslationPromptPlaceholders(document)
  if (documented.join('\n') !== TRANSLATION_PROMPT_PLACEHOLDERS.join('\n')) {
    throw new Error(`placeholder table must list exactly: ${TRANSLATION_PROMPT_PLACEHOLDERS.join(', ')}`)
  }

  const englishSource = renderTranslationPrompt(document, {
    sourceLanguage: 'English',
    sourceFilename: 'example.md',
    translationRules,
    terminology,
  })
  const chineseSource = renderTranslationPrompt(document, {
    sourceLanguage: 'Chinese',
    sourceFilename: 'example.zh.md',
    translationRules,
    terminology,
  })
  if (!englishSource.includes('[English](example.md) | 中文')) throw new Error('English-source render does not carry the Chinese switcher instruction')
  if (!chineseSource.includes('English | [中文](example.zh.md)')) throw new Error('Chinese-source render does not carry the English switcher instruction')

  const example = /```xml\n([\s\S]*?)\n```/.exec(englishSource)?.[1]
  if (example === undefined) throw new Error('rendered prompt has no XML response example')
  parseTranslationResponse(example)

  const roundTrip = { translation: 'first ]]> pass', review: '- [None] No corrections.', final: 'final ]]> text' }
  const parsed = parseTranslationResponse(renderTranslationResponse(roundTrip))
  if (JSON.stringify(parsed) !== JSON.stringify(roundTrip)) throw new Error('CDATA split rule does not round-trip response content')

  console.log('verify-translation-prompt: both directions render and the XML response contract parses.')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`verify-translation-prompt: ${message}`)
  process.exit(1)
}
