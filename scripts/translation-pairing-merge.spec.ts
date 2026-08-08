/** Integration coverage for automatic and explicit pairing-record conflict resolution. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gitBlobHash, storeGitBlob } from './translation-pairing-git.ts'
import {
  mergeTranslationPairingRecords,
  resolveTranslationPairingConflicts,
} from './translation-pairing-merge.ts'
import {
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'

const driver = fileURLToPath(new URL('./merge-translation-pairing.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx/esm'))
const fixtures: string[] = []

interface Fixture {
  env: NodeJS.ProcessEnv
  root: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function git(fixture: Fixture, args: string[]): string {
  return execFileSync('git', ['-C', fixture.root, ...args], {
    encoding: 'utf8',
    env: fixture.env,
  }).trim()
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`
}

function createFixture(attributes = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-translation-pairing-merge-'))
  fixtures.push(root)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'pairing@example.test',
    GIT_AUTHOR_NAME: 'Pairing Test',
    GIT_COMMITTER_EMAIL: 'pairing@example.test',
    GIT_COMMITTER_NAME: 'Pairing Test',
    GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DEFAULT_HASH: 'sha1',
  }
  const fixture = { env, root }
  execFileSync('git', ['init', '--quiet', '--initial-branch=master', root], { env })
  if (attributes) write(root, '.gitattributes', '*.i18n.yaml merge=dsh-translation-pairing\n')
  return fixture
}

function record(root: string, path: string, source: string, zh: string): string {
  const paths = translationPairPaths(path)
  write(root, paths.source, source)
  write(root, paths.zh, zh)
  const content = renderTranslationPairingRecord(paths, {
    sourceHash: storeGitBlob(root, Buffer.from(source)),
    zhHash: storeGitBlob(root, Buffer.from(zh)),
  })
  write(root, paths.meta, content)
  return content
}

const baseSource = '# Guide\n\nEnglish | [中文](guide.zh.md)\n\nAlpha base.\n\nBeta base.\n'
const baseZh = '# 指南\n\n[English](guide.md) | 中文\n\n甲基础。\n\n乙基础。\n'
const currentSource = baseSource.replace('Alpha base.', 'Alpha current.')
const currentZh = baseZh.replace('甲基础。', '甲当前。')
const otherSource = baseSource.replace('Beta base.', 'Beta other.')
const otherZh = baseZh.replace('乙基础。', '乙对侧。')
const mergedSource = currentSource.replace('Beta base.', 'Beta other.')
const mergedZh = currentZh.replace('乙基础。', '乙对侧。')

function commitPair(fixture: Fixture, source: string, zh: string, message: string): string {
  const sidecar = record(fixture.root, 'docs/guide.md', source, zh)
  git(fixture, ['add', '.'])
  git(fixture, ['commit', '-m', message])
  return sidecar
}

function createDivergedPair(fixture: Fixture): { ancestor: string; current: string; other: string } {
  const ancestor = commitPair(fixture, baseSource, baseZh, 'base')
  git(fixture, ['switch', '-c', 'current'])
  const current = commitPair(fixture, currentSource, currentZh, 'current')
  git(fixture, ['switch', 'master'])
  const other = commitPair(fixture, otherSource, otherZh, 'other')
  git(fixture, ['switch', 'current'])
  return { ancestor, current, other }
}

function expectMergedPair(fixture: Fixture): void {
  expect(readFileSync(join(fixture.root, 'docs/guide.md'), 'utf8')).toBe(mergedSource)
  expect(readFileSync(join(fixture.root, 'docs/guide.zh.md'), 'utf8')).toBe(mergedZh)
  expect(readFileSync(join(fixture.root, 'docs/guide.i18n.yaml'), 'utf8')).toBe(
    renderTranslationPairingRecord(translationPairPaths('docs/guide.md'), {
      sourceHash: gitBlobHash(Buffer.from(mergedSource)),
      zhHash: gitBlobHash(Buffer.from(mergedZh)),
    }),
  )
}

describe('translation pairing merge composition', () => {
  it('rejects a pairing-record path outside the repository', () => {
    const fixture = createFixture(false)

    expect(() => mergeTranslationPairingRecords(
      fixture.root,
      '../guide.i18n.yaml',
      '',
      '',
      '',
    )).toThrow('pairing record escapes the repository')
  })

  it('merges the owner blobs named by three valid records', () => {
    const fixture = createFixture(false)
    const records = createDivergedPair(fixture)

    const result = mergeTranslationPairingRecords(
      fixture.root,
      'docs/guide.i18n.yaml',
      records.ancestor,
      records.current,
      records.other,
    )

    expect(result.sourceContent.toString('utf8')).toBe(mergedSource)
    expect(result.zhContent.toString('utf8')).toBe(mergedZh)
    expect(result.sourceHash).toBe(gitBlobHash(Buffer.from(mergedSource)))
    expect(result.zhHash).toBe(gitBlobHash(Buffer.from(mergedZh)))
  })

  it('leaves owner-content conflicts for a human', () => {
    const fixture = createFixture(false)
    const ancestor = record(fixture.root, 'docs/guide.md', baseSource, baseZh)
    const current = record(
      fixture.root,
      'docs/guide.md',
      baseSource.replace('Alpha base.', 'Alpha current.'),
      baseZh.replace('甲基础。', '甲当前。'),
    )
    const other = record(
      fixture.root,
      'docs/guide.md',
      baseSource.replace('Alpha base.', 'Alpha other.'),
      baseZh.replace('甲基础。', '甲对侧。'),
    )

    expect(() => mergeTranslationPairingRecords(
      fixture.root,
      'docs/guide.i18n.yaml',
      ancestor,
      current,
      other,
    )).toThrow('docs/guide.md has content conflicts')
  })

  it('rejects structurally divergent clean owner merges', () => {
    const fixture = createFixture(false)
    const ancestor = record(fixture.root, 'docs/guide.md', baseSource, baseZh)
    const current = record(fixture.root, 'docs/guide.md', currentSource, currentZh)
    const other = record(
      fixture.root,
      'docs/guide.md',
      `${otherSource}\n## Extra\n`,
      otherZh,
    )

    expect(() => mergeTranslationPairingRecords(
      fixture.root,
      'docs/guide.i18n.yaml',
      ancestor,
      current,
      other,
    )).toThrow('clean merges diverge structurally')
  })

  it('refuses owners assigned to another merge strategy', () => {
    const fixture = createFixture(false)
    write(fixture.root, '.gitattributes', 'docs/*.md merge=custom-owner\n')
    const records = createDivergedPair(fixture)

    expect(() => mergeTranslationPairingRecords(
      fixture.root,
      'docs/guide.i18n.yaml',
      records.ancestor,
      records.current,
      records.other,
    )).toThrow('docs/guide.md uses merge=custom-owner')
  })

  it('runs as Git\'s custom driver and commits a clean composed record', () => {
    const fixture = createFixture()
    createDivergedPair(fixture)
    const command = [
      shellQuote(process.execPath),
      '--import', shellQuote(tsxLoader),
      shellQuote(driver),
      '%O', '%A', '%B', '%P',
    ].join(' ')
    git(fixture, ['config', 'merge.dsh-translation-pairing.driver', command])

    git(fixture, ['merge', '--no-edit', 'master'])

    expect(git(fixture, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expectMergedPair(fixture)
  })

  it('resolves an already-stopped generated-only conflict from index stages', () => {
    const fixture = createFixture(false)
    createDivergedPair(fixture)
    const merge = spawnSync('git', ['-C', fixture.root, 'merge', '--no-commit', 'master'], {
      encoding: 'utf8',
      env: fixture.env,
    })
    expect(merge.status).toBe(1)
    expect(git(fixture, ['diff', '--name-only', '--diff-filter=U'])).toBe('docs/guide.i18n.yaml')

    expect(resolveTranslationPairingConflicts(fixture.root)).toEqual(['docs/guide.i18n.yaml'])

    expect(git(fixture, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
    expectMergedPair(fixture)
  })

  it('refuses to confirm unstaged owner bytes after a stopped merge', () => {
    const fixture = createFixture(false)
    createDivergedPair(fixture)
    const merge = spawnSync('git', ['-C', fixture.root, 'merge', '--no-commit', 'master'], {
      encoding: 'utf8',
      env: fixture.env,
    })
    expect(merge.status).toBe(1)
    write(fixture.root, 'docs/guide.md', `${mergedSource}\nunstaged\n`)

    expect(() => resolveTranslationPairingConflicts(fixture.root)).toThrow(
      'docs/guide.md has unstaged content',
    )
    expect(git(fixture, ['diff', '--name-only', '--diff-filter=U'])).toBe('docs/guide.i18n.yaml')
  })
})
