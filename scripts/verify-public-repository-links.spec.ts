import { describe, expect, it } from 'vitest'
import { findInternalRepositoryReferences } from './verify-public-repository-links.ts'

describe('public repository link policy', () => {
  it('rejects internal repository references and accepts the public home', () => {
    const internalOwner = ['deepseek', 'harness'].join('-')
    const internalRepository = [internalOwner, internalOwner].join('/')
    const source = [
      'https://github.com/deepseek-ai/deepseek-harness-sdk',
      `https://github.com/${internalRepository}/issues/1`,
      `${internalOwner}#2`,
    ].join('\n')

    expect(findInternalRepositoryReferences('subject.md', source)).toEqual([
      { file: 'subject.md', line: 2 },
      { file: 'subject.md', line: 3 },
    ])
  })
})
