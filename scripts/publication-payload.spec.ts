import { describe, expect, it } from 'vitest'
import { isForbiddenPublicationFile, validateTarballPayload } from './publication-payload.ts'

function validateFixtureTarball(files: readonly string[]): () => void {
  return () => {
    validateTarballPayload(files, 'fixture.tgz')
  }
}

describe('publication payload policy', () => {
  it.each([
    'lib/index.js',
    'lib/types/index.d.ts',
    'lib/styles/base.css',
  ])('accepts %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(false)
  })

  it.each([
    'src',
    './src',
    'src/',
    'src/index.ts',
    './src/index.ts',
    String.raw`src\index.ts`,
    'lib/types/index.d.ts.map',
    './lib/types/index.d.ts.map',
  ])('rejects static manifest path %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(true)
  })

  it('rejects source members in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/src/index.ts',
    ])).toThrow('fixture.tgz publishes source file package/src/index.ts')
  })

  it('rejects declaration maps in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/types/index.d.ts.map',
    ])).toThrow('fixture.tgz publishes declaration map package/lib/types/index.d.ts.map')
  })

  it('accepts a clean packed tarball', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/index.js',
      'package/lib/types/index.d.ts',
      'package/lib/styles/base.css',
    ])).not.toThrow()
  })
})
