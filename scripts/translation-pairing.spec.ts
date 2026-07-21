/** Regression tests for the bilingual cutoff and structural signature. */

import { describe, expect, it } from 'vitest'
import {
  datedDocumentDate,
  isIsoDate,
  parseTranslationMarkdown,
  parseTranslationPairingManifest,
  requiresPairByDate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'

function signature(markdown: string) {
  return translationStructureSignature(parseTranslationMarkdown(markdown), 'counterpart.zh.md')
}

describe('translation pairing manifest', () => {
  it('accepts a real ISO cutoff and string-array fields', () => {
    expect(parseTranslationPairingManifest(JSON.stringify({
      requiredSince: '2026-07-14',
      required: ['README.md'],
      excluded: ['docs/generated/'],
    }))).toEqual({
      requiredSince: '2026-07-14',
      required: ['README.md'],
      excluded: ['docs/generated/'],
    })
  })

  it.each(['2026-7-14', '2026-02-29', '2026-13-01', 'not-a-date'])('rejects invalid cutoff %s', (cutoff) => {
    expect(isIsoDate(cutoff)).toBe(false)
    expect(() => parseTranslationPairingManifest(JSON.stringify({
      requiredSince: cutoff,
      required: [],
      excluded: [],
    }))).toThrow('requiredSince must be a valid YYYY-MM-DD date')
  })

  it('rejects non-string manifest arrays', () => {
    expect(() => parseTranslationPairingManifest(JSON.stringify({
      requiredSince: '2026-07-14',
      required: [42],
      excluded: [],
    }))).toThrow('required must be an array of strings')
  })
})

describe('date-based pairing frontier', () => {
  const cutoff = '2026-07-14'

  it('enforces the cutoff day and every later day, but not the preceding day', () => {
    expect(requiresPairByDate('.agents/notes/2026-07-13-before.md', cutoff)).toBe(false)
    expect(requiresPairByDate('.agents/notes/2026-07-14-at-cutoff.md', cutoff)).toBe(true)
    expect(requiresPairByDate('.agents/notes/2026-07-15-after.md', cutoff)).toBe(true)
  })

  it('matches only a date at the start of the basename', () => {
    expect(datedDocumentDate('.agents/notes/2026-07-14-proposal.md')).toBe('2026-07-14')
    expect(datedDocumentDate('docs/release-notes-2026-07-14-alpha.md')).toBeUndefined()
    expect(requiresPairByDate('docs/release-notes-2026-07-14-alpha.md', cutoff)).toBe(false)
  })
})

describe('translation structural signature', () => {
  it('accepts matching list kinds, starts, and item counts', () => {
    const source = signature('3. One\n4. Two\n\n- A\n- B\n')
    const counterpart = signature('3. 一\n4. 二\n\n- 甲\n- 乙\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([])
  })

  it('rejects an altered ordered-list start', () => {
    const source = signature('3. One\n4. Two\n\n- A\n- B\n')
    const counterpart = signature('1. 一\n2. 二\n\n- 甲\n- 乙\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'list (kind, start, item count) #1 diverges between the pair: "ordered:start=3:items=2" vs "ordered:start=1:items=2"',
    ])
  })

  it('rejects a missing list item', () => {
    const source = signature('- A\n- B\n')
    const counterpart = signature('- 甲\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'list (kind, start, item count) #1 diverges between the pair: "bullet:items=2" vs "bullet:items=1"',
    ])
  })

  it('rejects altered table row or column counts', () => {
    const source = signature('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n')
    const counterpart = signature('| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'table (row x column count) #1 diverges between the pair: "3x2" vs "2x2"',
    ])
  })
})
