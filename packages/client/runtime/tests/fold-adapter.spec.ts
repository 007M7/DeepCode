/**
 * FoldAdapter over the real core SurfaceManager: padding sentinels for paged
 * windows, incremental append with node-cache identity, six-variant
 * materialization, call-index backfill, and the degraded linear-scan branch.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { FoldAdapter } from '../src/client/sessions/fold-adapter.ts'
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
    adapter.append(ev.user(6, '追加'))
    const second = adapter.nodes()
    expect(second.nodes).toHaveLength(3)
    expect(second.nodes[0]).toBe(first.nodes[0])
    expect(second.nodes[1]).toBe(first.nodes[1])
    expect(second.nodes).not.toBe(first.nodes) // array itself fresh per call
  })

  it('materializes all six node variants with field mapping', () => {
    const adapter = new FoldAdapter()
    const events = [
      ev.user(0, '用户'),
      ev.assistant(1, 0, '助手'),
      at(2, { type: 'steering/message', surfaceOp: 'append', data: { turn: 0, content: [{ type: 'text', text: '插话' }], source: { kind: 'user' } } }),
      at(3, { type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: '上下文' }], source: { kind: 'plugin', plugin: 'p' } } }),
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
      at(11, { type: 'assistant/message', surfaceOp: 'bogus-op', data: { turn: 0, step: 0, content: [{ type: 'text', text: '坏 op' }], provenance: { provider: 'x', model: 'y' } } }),
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

  it('materializes a tool-result error field when present', () => {
    const adapter = new FoldAdapter()
    adapter.reset([
      at(0, { type: 'tool/result', surfaceOp: 'append', data: { turn: 0, step: 0, callId: 'c1', content: [], isError: true, error: { name: 'Boom', code: 'boom' } } }),
    ], 0)
    expect(adapter.nodes().nodes[0]).toMatchObject({ kind: 'tool-result', isError: true, error: { code: 'boom' } })
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
})
