/**
 * The bundle's substance is its patch file: the `dsh.patch` manifest field
 * must name a real, parseable patch list.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@cordisjs/plugin-include'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dsh?: { patch?: string } }
    expect(manifest.dsh?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.patch!), 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string }[] }[]).flatMap(patch => patch.insert ?? [])
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
  })
})
