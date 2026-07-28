/** Registration/capability behavior of the dialog backend (the seam's cordis half). */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import DialogDirectoryPicker from '../src/index.ts'

describe('DialogDirectoryPicker', () => {
  it('registers ctx.directoryPicker with a stable dialog capability and leaves with its fiber', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(DialogDirectoryPicker)
    await fiber.await()
    const picker = ctx.get('directoryPicker')
    expect(picker).toBeInstanceOf(DialogDirectoryPicker)
    const capability = picker!.capability()
    expect(capability.kind).toBe('dialog')
    // Stability: consumers may capture the capability object across calls.
    expect(picker!.capability()).toBe(capability)
    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })
})
