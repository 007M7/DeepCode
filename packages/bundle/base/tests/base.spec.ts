/**
 * The bundle's substance is its patch file: the convenience export must point
 * at the real, parseable patch list the `dsh.patch` manifest field declares.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@cordisjs/plugin-include'
import { patchPath } from '../src/index.ts'

describe('dsh-base bundle', () => {
  it('exports the path of a parseable patch list matching the manifest declaration', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dsh?: { patch?: string } }
    expect(manifest.dsh?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string }[] }[]).flatMap(patch => patch.insert ?? [])
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
  })
})
