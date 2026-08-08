/**
 * Acceptance-path coverage for the cordis-surface partition backstops
 * (`walkPartitionProblems` + the AST scan helpers): a declared Context key or
 * Events member the rendering projection cannot see must carry a named walk
 * exemption, an exemption must stay live in both directions, and the scan
 * itself must reach nested (`src/**`) and Events-only merge files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import { contextKeyMap, contextMergeFiles, eventNameList } from './cordis-walk.ts'
import { walkPartitionProblems } from './gen-cordis-catalog.ts'
import type { WalkPartitionInput, WalkPartitionMaps } from './gen-cordis-catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A consistent baseline the red cases mutate one facet at a time. */
function baseline(): { input: WalkPartitionInput; maps: WalkPartitionMaps } {
  return {
    input: {
      renderedKeys: new Map([['llm', 'packages/llm/llm/src/index.ts:10']]),
      renderedScopes: new Set(['llm']),
      renderedEventNames: new Set(['llm/request']),
      declaredKeys: new Map([
        ['llm', 'packages/llm/llm/src/index.ts'],
        ['theme', 'packages/client/ui-theme/src/client/index.ts'],
      ]),
      declaredEvents: new Map([
        ['llm/request', 'packages/llm/llm/src/index.ts'],
        ['theme/change', 'packages/client/ui-theme/src/client/index.ts'],
      ]),
    },
    maps: {
      servicePage: { llm: 'llm-streaming.md' },
      serviceWalkExemptions: { theme: 'client-side — packages/client/ui-theme/README.md owns the surface' },
      eventScopePage: { llm: 'llm-streaming.md' },
      eventWalkExemptions: { 'theme/change': 'client-face — packages/client/ui-theme/README.md owns the surface' },
    },
  }
}

describe('walkPartitionProblems', () => {
  it('accepts a partition where every declared key and event is rendered or exempted', () => {
    const { input, maps } = baseline()
    expect(walkPartitionProblems(input, maps)).toEqual([])
  })

  it('rejects a declared event that is neither rendered nor exempted, naming its file', () => {
    const { input, maps } = baseline()
    const problems = walkPartitionProblems(input, { ...maps, eventWalkExemptions: {} })
    expect(problems).toEqual([
      expect.stringContaining("event 'theme/change' (packages/client/ui-theme/src/client/index.ts) is declared in an Events merge but invisible"),
    ])
  })

  it('rejects an event exemption whose event the projection renders', () => {
    const { input, maps } = baseline()
    const rendered = { ...input, renderedEventNames: new Set(['llm/request', 'theme/change']) }
    expect(walkPartitionProblems(rendered, maps)).toEqual([
      expect.stringContaining("event 'theme/change' is rendered by the projection but still listed in EVENT_WALK_EXEMPTIONS"),
    ])
  })

  it('rejects an event exemption no Events merge declares', () => {
    const { input, maps } = baseline()
    const stale = { ...maps, eventWalkExemptions: { ...maps.eventWalkExemptions, 'gone/away': 'nothing owns this' } }
    expect(walkPartitionProblems(input, stale)).toEqual([
      expect.stringContaining("EVENT_WALK_EXEMPTIONS names 'gone/away' but no Events merge declares it"),
    ])
  })

  it('rejects a declared Context key that is neither rendered nor exempted', () => {
    const { input, maps } = baseline()
    const problems = walkPartitionProblems(input, { ...maps, serviceWalkExemptions: {} })
    expect(problems).toEqual([
      expect.stringContaining('ctx.theme (packages/client/ui-theme/src/client/index.ts) is declared in a Context merge but invisible'),
    ])
  })

  it('rejects an unmapped rendered service with its source pointer, and stale page maps both ways', () => {
    const { input, maps } = baseline()
    const problems = walkPartitionProblems(input, {
      ...maps,
      servicePage: { ghost: 'core.md' },
      eventScopePage: { specter: 'core.md' },
    })
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('service ctx.llm (packages/llm/llm/src/index.ts:10) has no SERVICE_PAGE entry'),
      expect.stringContaining("event scope 'llm/*' has no EVENT_SCOPE_PAGE entry"),
      expect.stringContaining("SERVICE_PAGE maps 'ctx.ghost' but the projection discovers no such service"),
      expect.stringContaining("EVENT_SCOPE_PAGE maps 'specter/*' but the projection discovers no such scope"),
    ]))
    expect(problems).toHaveLength(4)
  })
})

describe('cordis-walk scan reach', () => {
  it('finds Context keys and Events names in nested Events-only merge files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordis-walk-'))
    roots.push(root)
    const dir = join(root, 'packages/client/ui-x/src/client')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), [
      "declare module 'cordis' {",
      '  interface Events {',
      "    'x/changed'(): void",
      '  }',
      '}',
      'export {}',
      '',
    ].join('\n'))
    const merges = contextMergeFiles(root, 'packages/*/*/src/**/*.ts')
    expect(merges.map(m => m.rel)).toEqual(['packages/client/ui-x/src/client/index.ts'])
    const only = merges[0]
    if (!only) throw new Error('scan returned no merge')
    expect(eventNameList(only.body, only.sf)).toEqual(['x/changed'])
    expect([...contextKeyMap(only.body, only.sf).keys()]).toEqual([])
  })

  it('reads string-literal and identifier member names from an Events merge', () => {
    const sf = ts.createSourceFile('x.ts', [
      "declare module 'cordis' {",
      '  interface Events {',
      "    'scope/list'(items: string[]): void",
      '    plain(): void',
      '  }',
      '  interface Context {',
      '    thing: ThingService',
      '  }',
      '}',
      '',
    ].join('\n'), ts.ScriptTarget.Latest, true)
    const body = sf.statements[0] && ts.isModuleDeclaration(sf.statements[0]) && sf.statements[0].body
      && ts.isModuleBlock(sf.statements[0].body)
      ? sf.statements[0].body
      : null
    if (!body) throw new Error('fixture did not parse to a module block')
    expect(eventNameList(body, sf)).toEqual(['scope/list', 'plain'])
    expect([...contextKeyMap(body, sf)]).toEqual([['thing', 'ThingService']])
  })
})
