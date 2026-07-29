/**
 * The wire contract's home shape: a decorated HOME (trailing/repeated
 * separators, dot segments — homedir() ships it verbatim) still leaves the
 * listing carrying the resolved form, matching `path` and `crumbs[].path`.
 */

import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from 'cordis'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.homedir()}/.//.` }
})

it('resolves a decorated homedir before stamping listing.home', async () => {
  const { homedir } = await vi.importActual<typeof import('node:os')>('node:os')
  const { default: BrowseDirectoryPicker } = await import('../src/index.ts')
  const ctx = new Context()
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  const listing = await picked.list()
  expect(listing.home).toBe(resolve(homedir()))
  expect(listing.path).toBe(listing.home)
  await fiber.dispose()
})
