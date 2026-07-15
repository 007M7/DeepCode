/** Regression tests for the executable translation prompt contract. */

import { describe, expect, it } from 'vitest'
import {
  parseTranslationResponse,
  renderTranslationPrompt,
  renderTranslationResponse,
} from './translation-prompt.ts'

const document = `# Wrapper

## 模板正文

\`\`\`\`text
{{source_lang}} to {{target_lang}}
{{translation_rules}}
{{terminology}}
[English]({{source_filename}}) | [中文]({{source_filename_zh}})
\`\`\`\`
`

describe('translation prompt rendering', () => {
  it('renders every supported placeholder without recursively rewriting injected rules', () => {
    const rendered = renderTranslationPrompt(document, {
      sourceLanguage: 'English',
      sourceFilename: 'guide.md',
      translationRules: 'A literal {{source_lang}} in injected rules.',
      terminology: '| English | 中文 |',
    })
    expect(rendered).toContain('English to Chinese')
    expect(rendered).toContain('A literal {{source_lang}} in injected rules.')
    expect(rendered).toContain('[English](guide.md) | [中文](guide.zh.md)')
  })

  it('rejects a filename whose suffix contradicts the source language', () => {
    expect(() => renderTranslationPrompt(document, {
      sourceLanguage: 'Chinese',
      sourceFilename: 'guide.md',
      translationRules: 'rules',
      terminology: 'terms',
    })).toThrow('does not match source language Chinese')
  })

  it('rejects malformed template placeholders before injecting rule contents', () => {
    expect(() => renderTranslationPrompt(document.replace('{{source_lang}}', '{{source-lang}}'), {
      sourceLanguage: 'English',
      sourceFilename: 'guide.md',
      translationRules: 'A literal {{source_lang}} in injected rules.',
      terminology: '| English | 中文 |',
    })).toThrow('template contains malformed placeholder syntax')
  })
})

describe('translation response XML', () => {
  it('round-trips Markdown and the CDATA terminator', () => {
    const response = {
      translation: '# Draft\n\nA ]]> marker.',
      review: '- [Tone] Fixed.',
      final: '# Final\n\nA ]]> marker.',
    }
    expect(parseTranslationResponse(renderTranslationResponse(response))).toEqual(response)
  })

  it('rejects missing, reordered, nested, attributed, or non-CDATA children', () => {
    expect(() => parseTranslationResponse('<dsh-translation-response version="1"/>')).toThrow('translation, review, and final')
    expect(() => parseTranslationResponse('<dsh-translation-response version="1"><review><![CDATA[x]]></review></dsh-translation-response>'))
      .toThrow('expected translation, got review')
    expect(() => parseTranslationResponse(renderTranslationResponse({ translation: 'x', review: 'y', final: 'z' })
      .replace('<translation><![CDATA[x]]></translation>', '<translation><b><![CDATA[x]]></b></translation>')))
      .toThrow('nested element b is not allowed')
    expect(() => parseTranslationResponse(renderTranslationResponse({ translation: 'x', review: 'y', final: 'z' }).replace('<review>', '<review lang="en">')))
      .toThrow('review must not have attributes')
    expect(() => parseTranslationResponse(renderTranslationResponse({ translation: 'x', review: 'y', final: 'z' }).replace('<![CDATA[x]]>', 'x')))
      .toThrow('all response field content must be inside CDATA')
  })
})
