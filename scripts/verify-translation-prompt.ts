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
  const terminology = read('docs/i18n/terminology.md')
  const documented = documentedTranslationPromptPlaceholders(document)
  if (documented.join('\n') !== TRANSLATION_PROMPT_PLACEHOLDERS.join('\n')) {
    throw new Error(`placeholder table must list exactly: ${TRANSLATION_PROMPT_PLACEHOLDERS.join(', ')}`)
  }

  const englishSource = renderTranslationPrompt(document, { sourceLanguage: 'English', terminology })
  const chineseSource = renderTranslationPrompt(document, { sourceLanguage: 'Chinese', terminology })
  if (englishSource.includes('{{') || chineseSource.includes('{{')) throw new Error('rendered prompt contains an unresolved placeholder')
  if (!englishSource.includes('from English to Chinese')) throw new Error('English-source render does not translate into Chinese')
  if (!chineseSource.includes('from Chinese to English')) throw new Error('Chinese-source render does not translate into English')

  const example = /```xml\n([\s\S]*?)\n```/.exec(englishSource)?.[1]
  if (example === undefined) throw new Error('rendered prompt has no three-section response example')
  parseTranslationResponse(example)

  const roundTrip = { translation: 'first pass\n\nwith **markdown**', review: '- 无修正', final: 'final text' }
  const parsed = parseTranslationResponse(renderTranslationResponse(roundTrip))
  if (JSON.stringify(parsed) !== JSON.stringify(roundTrip)) throw new Error('three-section response does not round-trip')

  console.log('verify-translation-prompt: both directions render and the three-section response contract parses.')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`verify-translation-prompt: ${message}`)
  process.exit(1)
}
