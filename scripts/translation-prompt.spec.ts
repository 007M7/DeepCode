/** Unit tests for the prompt-v4 renderer and three-section response parser. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseTranslationResponse,
  renderTranslationPrompt,
  renderTranslationResponse,
} from './translation-prompt.ts'

const root = resolve(import.meta.dirname, '..')
const document = readFileSync(join(root, 'docs/i18n/translation-prompt.md'), 'utf8')
const terminology = '| English | 中文 |\n|---|---|\n| agent | agent |'

describe('translation prompt rendering', () => {
  it('renders both directions with every placeholder resolved', () => {
    const en = renderTranslationPrompt(document, { sourceLanguage: 'English', terminology })
    expect(en).toContain('from English to Chinese')
    expect(en).toContain(terminology)
    expect(en).not.toContain('{{')
    const zh = renderTranslationPrompt(document, { sourceLanguage: 'Chinese', terminology })
    expect(zh).toContain('from Chinese to English')
  })

  it('rejects a template with unknown or missing placeholders', () => {
    const alien = document.replaceAll('{{terminology}}', '{{terms_prompt}}')
    expect(() => renderTranslationPrompt(alien, { sourceLanguage: 'English', terminology })).toThrow(/unsupported placeholder/)
    const missing = document.replaceAll('{{terminology}}', '')
    expect(() => renderTranslationPrompt(missing, { sourceLanguage: 'English', terminology })).toThrow(/required placeholder/)
  })
})

describe('translation response sections', () => {
  it('round-trips Markdown bodies', () => {
    const response = { translation: '# 标题\n\n正文 **加粗**。', review: '- [Tone] 修正一处。\n- 无修正', final: '# 标题\n\n定稿。' }
    expect(parseTranslationResponse(renderTranslationResponse(response))).toEqual(response)
  })

  it('tolerates a fenced xml wrapper around the whole response', () => {
    const fenced = '```xml\n<translation>\nA\n</translation>\n\n<review>\n- 无修正\n</review>\n\n<final>\nA\n</final>\n```'
    expect(parseTranslationResponse(fenced).final).toBe('A')
  })

  it('rejects missing, unterminated, or duplicated sections', () => {
    expect(() => parseTranslationResponse('<translation>\nA\n</translation>')).toThrow(/missing <review>/)
    expect(() => parseTranslationResponse('<translation>\nA')).toThrow(/unterminated <translation>/)
    const dup = '<translation>\nA\n</translation>\n<review>\nR\n</review>\n<final>\nF\n</final>\n<final>\nG\n</final>'
    expect(() => parseTranslationResponse(dup)).toThrow(/duplicate <final>/)
  })
})
