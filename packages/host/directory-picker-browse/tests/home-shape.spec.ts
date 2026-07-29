/**
 * The wire contract's home shape: a decorated HOME (trailing/repeated
 * separators, dot segments — homedir() ships it verbatim) still leaves the
 * listing carrying the resolved form, matching `path` and `crumbs[].path`.
 * The mock points homedir at a scratch tree so the probe never scans the
 * running machine's real home (same hermetic reasoning as service.spec's
 * temporary tree); the mock spreads the actual module, so tmpdir stays real.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Context } from 'cordis'

let scratch: string

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${scratch}/.//.` }
})

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-home-shape-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

it('resolves a decorated homedir before stamping listing.home', async () => {
  const { default: BrowseDirectoryPicker } = await import('../src/index.ts')
  const ctx = new Context()
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  const listing = await picked.list()
  expect(listing.home).toBe(resolve(scratch))
  expect(listing.path).toBe(listing.home)
  await fiber.dispose()
})
