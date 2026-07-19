import { describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import * as stdio from '../src/index.ts'

/** Real Loader export-path guard for the namespace stdio plugin. */
describe('dsh-stdio plugin export shape', () => {
  it('preserves name, inject, Config, and apply through Loader unwrapping', () => {
    expect('default' in stdio).toBe(false)
    expect(typeof stdio.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(stdio) as Record<string, unknown>
    expect(unwrapped).toBe(stdio)
    expect(unwrapped.name).toBe('ui-stdio')
    expect(unwrapped.inject).toEqual(['agents', 'userInteraction'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
