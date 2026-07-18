import { describe, expect, it } from 'vitest'
import {
  closedInspectorState,
  createInspectorTargetId,
  DEFAULT_FEEDBACK_AUTHOR,
  DESKTOP_SURFACES,
  fullDetailBelongsInInspector,
  INSPECTOR_TABS,
  openInspectorState,
  opensInspector,
  ownsComposer,
  SURFACE_DEFINITIONS,
  SURFACE_POLICIES,
  type DesktopSurface,
  type InspectorTarget,
} from '../src/index.ts'

const target: InspectorTarget = {
  id: 'session:one:event:1',
  kind: 'message',
  title: 'user/message',
}

describe('desktop surface policies', () => {
  it('routes trace-analysis detail through the inspector, but not Develop', () => {
    for (const surface of DESKTOP_SURFACES.filter(surface => surface !== 'dev')) {
      expect(opensInspector(surface, target)).toBe(true)
      expect(fullDetailBelongsInInspector(surface)).toBe(true)
    }
    expect(opensInspector('dev', target)).toBe(false)
    expect(fullDetailBelongsInInspector('dev')).toBe(false)
  })

  it('keeps empty selections from opening the inspector', () => {
    expect(opensInspector('trajectory', undefined)).toBe(false)
  })

  it('keeps trajectory and context as summary-first surfaces', () => {
    expect(SURFACE_POLICIES.trajectory).toMatchObject({
      summaryFirst: true,
      inlinePreview: true,
      fullDetailInInspector: true,
    })
    expect(SURFACE_POLICIES.context).toMatchObject({
      summaryFirst: true,
      inlinePreview: true,
      fullDetailInInspector: true,
    })
  })

  it('keeps the composer scoped to chat only', () => {
    for (const surface of DESKTOP_SURFACES) {
      expect(ownsComposer(surface)).toBe(surface === 'chat')
    }
  })

  it('keeps surface definitions aligned with the exported surface list', () => {
    expect(Object.keys(SURFACE_DEFINITIONS).sort()).toEqual([...DESKTOP_SURFACES].sort())
    expect(SURFACE_DEFINITIONS.trajectory.purpose).toBe('navigate')
    expect(SURFACE_DEFINITIONS.context.purpose).toBe('request-anatomy')
    expect(SURFACE_DEFINITIONS.compare.primaryQuestion).toContain('baseline')
    expect(SURFACE_DEFINITIONS.dev.primaryQuestion).toContain('artifacts compose')
  })
})

describe('desktop inspector contracts', () => {
  it('uses stable target ids across surfaces', () => {
    expect(createInspectorTargetId({
      sessionId: 's1',
      runId: 'r1',
      kind: 'tool-call',
      eventSeq: 42,
    })).toBe('session:s1:run:r1:kind:tool-call:seq:42')
  })

  it('opens output by default for produced data and metadata for structural targets', () => {
    expect(openInspectorState({
      id: 'session:s1:kind:tool-result:seq:9',
      kind: 'tool-result',
      title: 'tool/result',
    }).activeTab).toBe('output')

    expect(openInspectorState({
      id: 'session:s1:kind:step:seq:3',
      kind: 'step',
      title: 'step 1',
    }).activeTab).toBe('metadata')
  })

  it('keeps inspector tabs ordered with feedback last', () => {
    expect(INSPECTOR_TABS).toEqual(['input', 'output', 'metadata', 'feedback'])
    expect(openInspectorState(target).tabs.map((tab) => tab.tab)).toEqual(INSPECTOR_TABS)
    expect(closedInspectorState()).toEqual({
      open: false,
      activeTab: 'input',
      tabs: [],
    })
  })

  it('uses shentuni as the default feedback author', () => {
    expect(DEFAULT_FEEDBACK_AUTHOR).toBe('shentuni')
  })
})
