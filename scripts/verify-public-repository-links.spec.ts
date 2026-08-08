import { describe, expect, it } from 'vitest'
import { findInternalRepositoryReferences } from './verify-public-repository-links.ts'

describe('public repository link policy', () => {
  it('rejects encoded and case-varied internal identities without blocking public repositories', () => {
    const internalOwner = ['deepseek', 'harness'].join('-')
    const internalRepository = [internalOwner, internalOwner].join('/')
    const encodedRepository = internalRepository.replaceAll('-', '%2D').replace('/', '%2F')
    const htmlEncodedRepository = internalRepository.replace('/', '&#x2f;')
    const jsonEscapedRepository = internalRepository.replace('/', '\\/')
    const unicodeEscapedRepository = internalRepository.replace('/', String.raw`\u002f`)
    const source = [
      'https://github.com/deepseek-ai/deepseek-harness-sdk',
      `https://github.com/${internalOwner}/cordis`,
      `https://github.com/${internalRepository.toUpperCase()}/issues/1`,
      `https://github.com/${encodedRepository}/issues/2`,
      `https://github.com/${htmlEncodedRepository}/issues/3`,
      `"https:\\/\\/github.com\\/${jsonEscapedRepository}\\/issues\\/4"`,
      `"https:\\/\\/github.com\\/${unicodeEscapedRepository}\\/issues\\/5"`,
      `${internalOwner.toUpperCase()}#6`,
    ].join('\n')

    expect(findInternalRepositoryReferences('subject.md', source)).toEqual([
      { file: 'subject.md', line: 3 },
      { file: 'subject.md', line: 4 },
      { file: 'subject.md', line: 5 },
      { file: 'subject.md', line: 6 },
      { file: 'subject.md', line: 7 },
      { file: 'subject.md', line: 8 },
    ])
  })
})
