/** Regression tests for the minimal-update briefing assembly. */

import { describe, expect, it } from 'vitest'
import {
  changedLinesOfDiff,
  extractCounterpartSections,
  headingSections,
  mapHunksToSections,
  matchTerminologyRows,
  parseUnifiedDiffHunks,
  renderTranslationBrief,
} from './translation-brief.ts'

const DIFF = [
  '@@ -3,3 +3,3 @@',
  ' unchanged context',
  '-The agent loop retries once.',
  '+The agent loop retries twice.',
  '@@ -12 +12,2 @@',
  '+A new sentence about the session log.',
].join('\n')

describe('unified diff parsing', () => {
  it('reads hunk starts and counts, defaulting count to 1', () => {
    expect(parseUnifiedDiffHunks(DIFF)).toEqual([
      { start: 3, count: 3 },
      { start: 12, count: 1 },
    ])
  })

  it('collects only changed lines, markers stripped', () => {
    expect(changedLinesOfDiff(DIFF)).toBe([
      'The agent loop retries once.',
      'The agent loop retries twice.',
      'A new sentence about the session log.',
    ].join('\n'))
  })

  it('ignores file header lines that also start with +/-', () => {
    expect(changedLinesOfDiff('--- a/foo.md\n+++ b/foo.md\n+added')).toBe('added')
  })
})

const DOC = [
  'Preamble line.',
  '',
  '# Title',
  '',
  'Intro paragraph.',
  '',
  '## First',
  '',
  'First body.',
  '',
  '## Second',
  '',
  'Second body.',
].join('\n')

describe('section mapping', () => {
  it('lists headings with lines, depths, and labels', () => {
    expect(headingSections(DOC)).toEqual([
      { line: 3, depth: 1, label: 'Title' },
      { line: 7, depth: 2, label: 'First' },
      { line: 11, depth: 2, label: 'Second' },
    ])
  })

  it('maps hunks to the sections they span, including the preamble', () => {
    const headings = headingSections(DOC)
    expect(mapHunksToSections([{ start: 1, count: 1 }], headings)).toEqual([0])
    expect(mapHunksToSections([{ start: 9, count: 1 }], headings)).toEqual([2])
    expect(mapHunksToSections([{ start: 9, count: 4 }], headings)).toEqual([2, 3])
    expect(mapHunksToSections([{ start: 0, count: 0 }], headings)).toEqual([0])
  })

  it('extracts counterpart section text with start lines and labels', () => {
    expect(extractCounterpartSections(DOC, [0, 2])).toEqual([
      { label: '(preamble before the first heading)', startLine: 1, text: 'Preamble line.' },
      { label: '## First', startLine: 7, text: '## First\n\nFirst body.' },
    ])
  })
})

const TERMINOLOGY = [
  '| English | 中文 | 首次出现 | 不要译作 | 备注 |',
  '|---|---|---|---|---|',
  '| agent loop | agent loop | agent loop（智能体循环） | | |',
  '| session log | 会话日志 | | 会话记录 | |',
  '| gate | 门禁 | | | |',
].join('\n')

describe('terminology matching', () => {
  it('selects rows whose English term appears on a word boundary', () => {
    const matches = matchTerminologyRows(TERMINOLOGY, 'The agent loop retries twice.')
    expect(matches.rows).toEqual(['| agent loop | agent loop | agent loop（智能体循环） | | |'])
    expect(matches.header).toContain('English')
  })

  it('selects rows whose Chinese term appears when the source is Chinese', () => {
    expect(matchTerminologyRows(TERMINOLOGY, '门禁在提交时运行。').rows).toEqual(['| gate | 门禁 | | | |'])
  })

  it('does not match substrings inside larger words', () => {
    expect(matchTerminologyRows(TERMINOLOGY, 'delegate the work').rows).toEqual([])
  })
})

describe('brief rendering', () => {
  const base = {
    sourcePath: 'docs/foo.md',
    counterpartPath: 'docs/foo.zh.md',
    direction: 'en-to-zh' as const,
    diff: DIFF,
    counterpartSections: [{ label: '## First', startLine: 7, text: '## First\n\n正文。' }],
    bothDrifted: false,
    terminology: matchTerminologyRows(TERMINOLOGY, changedLinesOfDiff(DIFF)),
  }

  it('renders diff, aligned sections, terminology, digest, and finish steps', () => {
    const brief = renderTranslationBrief(base)
    expect(brief).toContain('# Translation update briefing: docs/foo.md')
    expect(brief).toContain('```diff')
    expect(brief).toContain('docs/foo.zh.md:7')
    expect(brief).toContain('agent loop（智能体循环）')
    expect(brief).toContain('| 会话日志 |')
    expect(brief).toContain('Rules digest')
    expect(brief).toContain('verify-translation-pairing --write docs/foo.md')
    expect(brief).toContain('smallest edit that covers the diff')
  })

  it('warns instead of showing sections when both sides drifted', () => {
    const brief = renderTranslationBrief({ ...base, bothDrifted: true, counterpartSections: undefined })
    expect(brief).toContain('BOTH sides changed')
    expect(brief).toContain('locate the regions yourself')
    expect(brief).not.toContain('docs/foo.zh.md:7')
  })

  it('renders the English-target digest for zh-to-en updates', () => {
    const brief = renderTranslationBrief({
      ...base,
      direction: 'zh-to-en',
      sourcePath: 'docs/foo.zh.md',
      counterpartPath: 'docs/foo.md',
    })
    expect(brief).toContain('exactly what the new Chinese states')
    expect(brief).toContain('verify-translation-pairing --write docs/foo.md')
  })

  it('grows the section fence past tilde runs in the body', () => {
    const brief = renderTranslationBrief({
      ...base,
      counterpartSections: [{ label: '## First', startLine: 7, text: '~~~~\ninner\n~~~~' }],
    })
    expect(brief).toContain('~~~~~markdown')
  })
})
