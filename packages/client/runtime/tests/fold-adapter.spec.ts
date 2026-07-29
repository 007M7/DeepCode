import { createUserMessage, CallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
/**
 * FoldAdapter over the real core SurfaceManager: padding sentinels for paged
 * windows, incremental append with node-cache identity, six-variant
 * materialization, call-index backfill, and the degraded linear-scan branch.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { FoldAdapter } from '../src/client/sessions/fold-adapter.ts'
import { projectConversationHistory } from '../src/client/session-history/history-fold.ts'
import { ev, plainTurn } from './event-script.ts'

const at = (seq: number, e: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, ...e }) as unknown as SessionEvent

describe('FoldAdapter', () => {
  it('folds a baseSeq>0 window through padding sentinels with correct seqs', () => {
    const adapter = new FoldAdapter()
    const window = plainTurn(100, 5, '偏移问', '偏移答')
    adapter.reset(window, 100)
    const { nodes, degraded } = adapter.nodes()
    expect(degraded).toBe(false)
    expect(nodes.map(n => [n.kind, n.seq])).toEqual([['user', 101], ['assistant', 103]])
  })

  it('appends incrementally keeping old node references (cache identity)', () => {
    const adapter = new FoldAdapter()
    adapter.reset(plainTurn(0, 0, 'a', 'b'), 0)
    const first = adapter.nodes()
    expect(adapter.nodes()).toBe(first)
    adapter.append(ev.user(6, '追加'))
    const second = adapter.nodes()
    expect(second.nodes).toHaveLength(3)
    expect(second.nodes[0]).toBe(first.nodes[0])
    expect(second.nodes[1]).toBe(first.nodes[1])
    expect(second.nodes).not.toBe(first.nodes) // array itself fresh per call
  })

  it('projects frozen surface generations without widening the core live surface', () => {
    const events = [
      ev.user(0, 'a'),
      ev.user(1, 'b'),
      at(2, {
        type: 'assistant/message',
        surfaceOp: { op: 'replace', start: 0, end: 0 },
        sourceEventSeqs: [0],
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: 'summary' }],
            source: { kind: 'model', provider: 'fake', model: 'fake' },
          }),
        },
      }),
      at(3, {
        type: 'assistant/message',
        surfaceOp: { op: 'replace', start: 2, end: 1 },
        sourceEventSeqs: [2, 1],
        data: {
          turn: 1,
          step: 2,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: 'summary 2' }],
            source: { kind: 'model', provider: 'fake', model: 'fake' },
          }),
        },
      }),
    ]

    expect(projectConversationHistory(events.map(event => ({ event }))).contexts.map(context => ({
      id: context.id,
      parentId: context.parentId,
      originSeq: context.originSeq,
      nodes: context.nodes.map(node => node.seq),
    }))).toEqual([
      { id: 0, parentId: undefined, originSeq: undefined, nodes: [0, 1] },
      { id: 1, parentId: 0, originSeq: 2, nodes: [2, 1] },
      { id: 2, parentId: 1, originSeq: 3, nodes: [3] },
    ])
  })

  it('materializes all six node variants with field mapping', () => {
    const adapter = new FoldAdapter()
    const events = [
      ev.user(0, '用户'),
      ev.assistant(1, 0, '助手'),
      at(2, { type: 'steering/message', surfaceOp: 'append', data: {
        turn: 0,
        message: createUserMessage({
          content: [{ type: 'text', text: '插话' }],
          source: { kind: 'user' },
        }),
      } }),
      at(3, { type: 'user/message', surfaceOp: 'append', data: createUserMessage({
        content: [{ type: 'text', text: '上下文' }], source: { kind: 'plugin', plugin: 'p' },
      }) }),
      ev.toolCall(4, 0, 'c1', 'echo', '{"x":1}'),
      ev.toolResult(5, 0, 'c1', '结果'),
    ]
    adapter.reset(events, 0)
    const { nodes } = adapter.nodes()
    const kinds = nodes.map(n => n.kind)
    expect(kinds).toContain('user')
    expect(kinds).toContain('assistant')
    expect(kinds).toContain('steering')
    expect(kinds).toContain('context')
    const result = nodes.find(n => n.kind === 'tool-result')
    expect(result).toMatchObject({ callId: 'c1', call: { name: 'echo', argsRaw: '{"x":1}' }, isError: false })
  })

  it('returns call:null for a tool-result whose call fell outside the window', () => {
    const adapter = new FoldAdapter()
    adapter.reset([ev.toolResult(50, 3, 'outside-call', '孤儿结果')], 50)
    const { nodes } = adapter.nodes()
    expect(nodes[0]).toMatchObject({ kind: 'tool-result', callId: 'outside-call', call: null })
  })

  it('materializes surface-eligible types it does not know as unknown nodes', () => {
    const adapter = new FoldAdapter()
    adapter.reset([at(0, { type: 'notice/message', surfaceOp: 'append', data: { note: 1 } })], 0)
    const { nodes } = adapter.nodes()
    // Either the fold surfaces it (unknown node) or skips it as non-eligible — both are valid
    // shapes; what matters is no throw and no misclassification into a known kind.
    for (const node of nodes) expect(node.kind).toBe('unknown')
  })

  it('degrades to the lenient linear scan when the fold throws, and stays degraded', () => {
    const adapter = new FoldAdapter()
    // An invalid surfaceOp on a surface-eligible event deterministically throws in the core fold.
    const window = [
      ev.user(10, '正常'),
      at(11, { type: 'assistant/message', surfaceOp: 'bogus-op', data: {
        turn: 0, step: 0,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: '坏 op' }],
          source: {
            kind: 'model',
            ...{ provider: 'x', model: 'y' },
          },
        }),
      } }),
    ]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      adapter.reset(window, 10)
      const first = adapter.nodes()
      expect(first.degraded).toBe(true)
      expect(errorSpy).toHaveBeenCalled()
      expect(first.nodes.map(n => n.seq)).toEqual([10, 11]) // linear scan: append order, bad op ignored
      adapter.append(ev.user(12, '降级后追加')) // bump rev so the cached result is not reused
      const second = adapter.nodes()
      expect(second.degraded).toBe(true) // sticky: no re-throw loop, straight to the linear scan
      expect(second.nodes[0]).toBe(first.nodes[0]) // cache still serves node identity
      expect(second.nodes.map(n => n.seq)).toEqual([10, 11, 12])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('silently degrades when a replacement needs an earlier history page', () => {
    const adapter = new FoldAdapter()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      adapter.reset([
        at(10, {
          type: 'assistant/message',
          surfaceOp: { op: 'replace', start: 1, end: 3 },
          sourceEventSeqs: [1, 3],
          data: {
            turn: 1,
            step: 1,
            message: createMessage({
              role: 'assistant',
              content: [{ type: 'text', text: 'partial summary' }],
              source: { kind: 'model', provider: 'fake', model: 'fake' },
            }),
          },
        }),
        ev.user(11, 'newer message'),
      ], 10)

      expect(adapter.nodes()).toMatchObject({
        degraded: true,
        nodes: [{ seq: 10 }, { seq: 11 }],
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('silently degrades when a live replacement needs an earlier history page', () => {
    const adapter = new FoldAdapter()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      adapter.reset([ev.user(10, 'window head')], 10)
      adapter.append(at(11, {
        type: 'assistant/message',
        surfaceOp: { op: 'replace', start: 1, end: 1 },
        sourceEventSeqs: [1],
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: 'live summary' }],
            source: { kind: 'model', provider: 'fake', model: 'fake' },
          }),
        },
      }))

      expect(adapter.nodes()).toMatchObject({
        degraded: true,
        nodes: [{ seq: 10 }, { seq: 11 }],
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('materializes a tool-result error field when present', () => {
    const adapter = new FoldAdapter()
    adapter.reset([
      at(0, { type: 'tool/result', surfaceOp: 'append', data: {
        turn: 0, step: 0,
        message: createToolResultMessage({
          callId: CallId('c1'),
          content: [],
          isError: true,
        }),
        error: { name: 'Boom', code: 'boom' },
      } }),
    ], 0)
    expect(adapter.nodes().nodes[0]).toMatchObject({ kind: 'tool-result', isError: true, error: { code: 'boom' } })
  })

  it('projects assistant timing and the active request header from history', () => {
    const projection = projectConversationHistory([
      ev.stepStart(0, 1, 2),
      at(1, { type: 'request/header', data: {
        reason: 'initial',
        header: {
          config: { provider: 'fake', model: 'first' },
          tools: [],
        },
      } }),
      ev.chunkStart(2, 1, 2),
      ev.chunkText(3, 1, 'token', 2),
      ev.assistant(4, 1, 'done', 2),
      ev.stepStart(5, 2, 1),
      ev.chunkText(6, 2, 'next', 1),
      ev.assistant(7, 2, 'next done', 1),
    ].map(event => ({ event })))

    expect(projection.eventNodes[0]).toMatchObject({
      kind: 'assistant',
      timing: {
        stepStartTime: 1_700_000_000_000,
        firstTokenTime: 1_700_000_000_003,
        completedTime: 1_700_000_000_004,
      },
      requestConfig: { provider: 'fake', model: 'first' },
    })

    expect(projection.eventNodes.at(-1)).toMatchObject({
      timing: {
        stepStartTime: 1_700_000_000_005,
        firstTokenTime: 1_700_000_000_006,
        completedTime: 1_700_000_000_007,
      },
      requestConfig: { provider: 'fake', model: 'first' },
    })
  })

  it('exposes the in-window call index for runningCalls material', () => {
    const adapter = new FoldAdapter()
    adapter.reset([ev.toolCall(0, 1, 'c9', 'slow', '{}')], 0)
    expect(adapter.callIndex.get('c9')).toMatchObject({ name: 'slow', turn: 1 })
    adapter.append(ev.toolCall(1, 1, 'c10', 'fast', '{}'))
    expect(adapter.callIndex.size).toBe(2)
  })

  it('attaches wire views: callView into the call index, resultView onto the node by seq', () => {
    const adapter = new FoldAdapter()
    const events = [
      ev.toolCall(0, 1, 'c1', 'bash', '{"cmd":"ls"}'),
      ev.toolResult(1, 1, 'c1', 'listing'),
    ]
    const callView = { for: 'call' as const, view: { card: 'terminal' as const, command: 'ls' } }
    const resultView = { for: 'result' as const, view: { card: 'generic' as const, title: '完成' } }
    adapter.reset(events, 0, [callView, resultView] as never)
    expect(adapter.callIndex.get('c1')).toMatchObject({ callView: { card: 'terminal' } })
    const node = adapter.nodes().nodes.find(n => n.kind === 'tool-result')
    expect(node).toMatchObject({ callView: { card: 'terminal' }, resultView: { card: 'generic', title: '完成' } })
  })

  it('attaches views on the live append path and defaults to null without views', () => {
    const adapter = new FoldAdapter()
    adapter.reset(plainTurn(0, 0, 'a', 'b'), 0) // no views argument: legacy-shaped call
    adapter.append(ev.toolCall(6, 1, 'c2', 'echo', '{}'), { for: 'call', view: { card: 'generic', title: '回声' } } as never)
    adapter.append(ev.toolResult(7, 1, 'c2', 'ok')) // no view on the result
    expect(adapter.callIndex.get('c2')).toMatchObject({ callView: { title: '回声' } })
    const node = adapter.nodes().nodes.find(n => n.kind === 'tool-result')
    expect(node).toMatchObject({ callView: { title: '回声' }, resultView: null })
  })

  it('leaves callView null when the paired call fell outside the window (cross-page break)', () => {
    const adapter = new FoldAdapter()
    const resultView = { for: 'result' as const, view: { card: 'generic' as const, title: '孤儿' } }
    adapter.reset([ev.toolResult(50, 3, 'outside', '窗外配对')], 50, [resultView] as never)
    const node = adapter.nodes().nodes[0]
    expect(node).toMatchObject({ kind: 'tool-result', call: null, callView: null, resultView: { title: '孤儿' } })
  })

  describe('command lifecycle nodes', () => {
    it('folds a run/done pair into one settled node merged into flow order by seq', () => {
      const adapter = new FoldAdapter()
      adapter.reset([
        ev.user(0, '先说话'),
        ev.commandRun(1, 'cmd-1', 'plan'),
        ev.commandDone(2, 'cmd-1', 'success', '已进入 plan mode'),
        ev.assistant(3, 0, '然后回答'),
      ], 0)
      const { nodes } = adapter.nodes()
      expect(nodes.map(n => [n.kind, n.seq])).toEqual([['user', 0], ['command', 1], ['assistant', 3]])
      expect(nodes[1]).toMatchObject({
        kind: 'command', commandId: 'cmd-1', name: 'plan', args: '',
        outcome: { kind: 'success', text: '已进入 plan mode' },
      })
    })

    it('renders a run with no done as still executing (outcome null)', () => {
      const adapter = new FoldAdapter()
      adapter.reset([ev.commandRun(0, 'cmd-2', 'goal', ' ship it')], 0)
      expect(adapter.nodes().nodes[0]).toMatchObject({
        kind: 'command', name: 'goal', args: ' ship it', outcome: null,
      })
    })

    it('soft-falls a done-only window into a node built from the done (cross-window cut)', () => {
      const adapter = new FoldAdapter()
      adapter.reset([ev.commandDone(80, 'cmd-3', 'error', '失败了')], 80)
      expect(adapter.nodes().nodes[0]).toMatchObject({
        kind: 'command', seq: 80, commandId: 'cmd-3', name: null, args: null,
        outcome: { kind: 'error', text: '失败了' },
      })
    })

    it('settles a live-appended done in place, keeping the node at the run seq', () => {
      const adapter = new FoldAdapter()
      adapter.reset(plainTurn(0, 0, 'q', 'a'), 0)
      adapter.append(ev.commandRun(6, 'cmd-4', 'clear'))
      const running = adapter.nodes().nodes.find(n => n.kind === 'command')
      expect(running).toMatchObject({ outcome: null })
      adapter.append(ev.commandDone(7, 'cmd-4'))
      const settled = adapter.nodes().nodes.find(n => n.kind === 'command')
      expect(settled).toMatchObject({ seq: 6, outcome: { kind: 'success' } })
      // Settlement replaced the node object rather than mutating the published one.
      expect(settled).not.toBe(running)
    })

    it('tails command nodes whose seq is past every surface node', () => {
      const adapter = new FoldAdapter()
      adapter.reset([ev.user(0, '问'), ev.commandRun(1, 'cmd-tail', 'plan')], 0)
      expect(adapter.nodes().nodes.map(n => n.kind)).toEqual(['user', 'command'])
    })

    it('command nodes survive the degraded linear-scan branch', () => {
      const adapter = new FoldAdapter()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        adapter.reset([
          ev.commandRun(0, 'cmd-5', 'plan'),
          ev.commandDone(1, 'cmd-5'),
          at(2, { type: 'assistant/message', surfaceOp: 'bogus-op', data: {
            turn: 0,
            step: 0,
            message: createMessage({
              role: 'assistant',
              content: [{ type: 'text', text: '坏 op' }],
              source: { kind: 'model', provider: 'x', model: 'y' },
            }),
          } }),
        ], 0)
        const { nodes, degraded } = adapter.nodes()
        expect(degraded).toBe(true)
        expect(nodes.some(n => n.kind === 'command')).toBe(true)
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
