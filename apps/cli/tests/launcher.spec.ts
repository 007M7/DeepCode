/** Launcher-visible DeepCode process identity behavior. */

import { afterEach, describe, expect, it } from 'vitest'
import { applyProfileProcessIdentity } from '../src/launcher.ts'

const originalTitle = process.title

afterEach(() => { process.title = originalTitle })

describe('applyProfileProcessIdentity()', () => {
  it('brands both direct and profile-form CLI launches without renaming other profiles', () => {
    process.title = 'dsh'
    applyProfileProcessIdentity('web')
    expect(process.title).toBe('dsh')

    applyProfileProcessIdentity('cli')
    expect(process.title).toBe('DeepCode')
  })
})
