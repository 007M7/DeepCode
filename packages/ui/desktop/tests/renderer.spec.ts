// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/global.d.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('desktop renderer chat lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.body.innerHTML = '<div id="app"></div>'
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value.replaceAll(':', '\\:') },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('preserves drafts while streaming a single ACP block and exits the completed state', async () => {
    const firstPrompt = deferred<unknown>()
    const secondPrompt = deferred<unknown>()
    const promptQueue = [firstPrompt, secondPrompt]
    let update: ((payload: unknown) => void) | undefined
    let sessions: unknown[] = []
    let traceRead: unknown
    const completedTrace = {
      found: true,
      sessionId: 's-new',
      header: { id: 's-new' },
      rawText: '',
      feedback: [],
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' } } },
        { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hello' }] } },
        { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'why' } } },
        { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 1, content: [{ type: 'reasoning', text: 'why' }, { type: 'text', text: 'final answer' }] } },
        { type: 'tool/call', seq: 5, time: 6, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } },
        { type: 'tool/result', seq: 6, time: 7, data: { turn: 1, step: 1, callId: 'call-1', content: [{ type: 'text', text: '/repo' }] } },
        { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }
    const secondTrace = {
      ...completedTrace,
      events: [
        ...completedTrace.events,
        { type: 'turn/start', seq: 9, time: 10, data: { turn: 2, trigger: { kind: 'message' } } },
        { type: 'user/message', seq: 10, time: 11, data: { content: [{ type: 'text', text: 'second' }] } },
        { type: 'step/start', seq: 11, time: 12, data: { turn: 2, step: 1 } },
        { type: 'assistant/message', seq: 12, time: 13, data: { turn: 2, step: 1, content: [{ type: 'text', text: 'second answer' }] } },
        { type: 'step/end', seq: 13, time: 14, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: 14, time: 15, data: { turn: 2, reason: { kind: 'completed' } } },
      ],
    }
    traceRead = completedTrace

    window.dshDesktop = {
      runtime: {
        start: async () => ({}),
        stop: async () => ({}),
        restart: async () => ({}),
        status: async () => ({ state: 'running', repoRoot: '/repo' }),
        onStatus: () => () => {},
        onStderr: () => () => {},
      },
      sessions: {
        list: async () => ({ sessions }),
        create: async () => ({ sessionId: 's-new', trace: { ...completedTrace, events: [] } }),
        load: async () => ({}),
        prompt: async () => promptQueue.shift()!.promise,
        cancel: async () => ({}),
        reveal: async () => ({}),
        onUpdate: (callback: (payload: unknown) => void) => {
          update = callback
          return () => {}
        },
      },
      trace: { read: async () => traceRead },
      feedback: { list: async () => [], add: async () => ({}) },
      dev: { status: async () => ({ git: {} }), openPath: async () => ({}) },
    }

    await import('../src/app.ts')
    await vi.waitFor(() => {
      expect(document.querySelector('#composerInput')).not.toBeNull()
    })

    const newSession = document.querySelector<HTMLButtonElement>('[data-action="new-session"]')!
    newSession.click()
    const composer = document.querySelector<HTMLTextAreaElement>('#composerInput')!
    composer.value = 'hello'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('#composerForm')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => {
      expect(document.querySelector('#topbarTitle')?.textContent).toBe('hello')
    })
    const search = document.querySelector<HTMLInputElement>('#sessionSearch')!
    search.value = 'keep search'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    composer.value = 'next draft'
    composer.dispatchEvent(new Event('input', { bubbles: true }))

    const chatView = document.querySelector<HTMLElement>('#chatView')!
    Object.defineProperties(chatView, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    chatView.dispatchEvent(new Event('scroll'))
    update?.({ sessionId: 's-new', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'streamed' } } })
    expect(document.querySelector('[data-live="answer"]')?.textContent).toBe('streamed')
    expect(document.querySelector('#liveTurn .message.live')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('#liveJump')?.hidden).toBe(false)
    expect(composer.value).toBe('next draft')
    expect(search.value).toBe('keep search')

    document.querySelector<HTMLButtonElement>('#liveJump')!.click()
    expect(chatView.scrollTop).toBe(1000)
    expect(document.querySelector<HTMLButtonElement>('#liveJump')?.hidden).toBe(true)

    sessions = [{
      id: 's-new',
      title: 'hello',
      createdAt: 1,
      lastActivity: 6,
      eventCount: 6,
      turnCount: 1,
      stepCount: 1,
      toolCallCount: 0,
      live: true,
    }]
    firstPrompt.resolve({ response: { stopReason: 'end_turn' }, trace: completedTrace })

    await vi.waitFor(() => {
      expect(document.querySelector('#conversation')?.textContent).toContain('final answer')
    })
    expect(document.querySelector<HTMLButtonElement>('#cancelButton')?.hidden).toBe(true)
    expect(document.querySelector('#liveTurn')?.textContent).not.toContain('正在生成')
    expect(composer.value).toBe('next draft')

    composer.value = 'second'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('#composerForm')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    update?.({ sessionId: 's-new', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second streamed' } } })
    secondPrompt.resolve({ response: { stopReason: 'end_turn' }, trace: completedTrace })

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#conversation .message')).toHaveLength(2)
      expect(document.querySelector('#liveTurn')?.textContent).toContain('second streamed')
    })

    traceRead = secondTrace
    document.querySelector<HTMLButtonElement>('[data-surface="trajectory"]')!.click()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#conversation .message')).toHaveLength(4)
    })
    expect([...document.querySelectorAll('#conversation .message')].map(node => node.textContent))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('hello'),
        expect.stringContaining('final answer'),
        expect.stringContaining('second'),
        expect.stringContaining('second answer'),
      ]))
    expect(document.querySelector('#liveTurn')?.textContent).toBe('')

    const firstAssistant = document.querySelectorAll<HTMLElement>('.message.assistant')[0]!
    const thinking = firstAssistant.querySelector<HTMLElement>('.chat-activity.thinking')!
    const thinkingButton = thinking.querySelector<HTMLButtonElement>('.activity-select')!
    thinkingButton.click()
    expect({
      targetId: thinkingButton.dataset.targetId,
      kind: document.querySelector('#inspectorKind')?.textContent,
      title: document.querySelector('#inspectorTitle')?.textContent,
    }).toEqual({ targetId: 'reasoning:1:1', kind: '思考', title: '思考' })

    const tool = firstAssistant.querySelector<HTMLElement>('.chat-activity.tool-use')!
    tool.querySelector<HTMLButtonElement>('.activity-select')!.click()
    expect(document.querySelector('#inspectorKind')?.textContent).toBe('工具')

    document.querySelectorAll<HTMLElement>('[data-target-id^="assistant:"]')[1]!.click()
    expect(document.querySelector<HTMLElement>('#inspector')?.hidden).toBe(false)
    expect(document.querySelector('#inspectorTitle')?.textContent).toBe('回复')

    document.querySelector<HTMLButtonElement>('[data-action="close-inspector"]')!.click()
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-module="develop"]')!.click()
    const rail = document.querySelector<HTMLElement>('.develop-artifact-rail')!
    const detail = document.querySelector<HTMLElement>('.develop-artifact-detail')!
    rail.scrollTop = 180
    detail.scrollTop = 220
    document.querySelectorAll<HTMLButtonElement>('[data-dev-artifact]')[1]!.click()
    expect(document.querySelector('.develop-artifact-rail')).toBe(rail)
    expect(document.querySelector('.develop-artifact-detail')).toBe(detail)
    expect(rail.scrollTop).toBe(180)
    expect(detail.scrollTop).toBe(220)

    document.querySelector<HTMLButtonElement>('[data-session="s-new"]')!.click()
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#sessionCanvas')?.hidden).toBe(false)
      expect(document.querySelector<HTMLElement>('#devCanvas')?.hidden).toBe(true)
    })

    document.querySelector<HTMLButtonElement>('[data-surface="waterfall"]')!.click()
    const chatToolTarget = document.querySelector<HTMLElement>('.chat-activity.tool-use [data-target-id]')?.dataset.targetId
    const trajectoryToolTarget = document.querySelector<HTMLElement>('.traj-row.tool')?.dataset.targetId
    const waterfallToolTarget = document.querySelector<HTMLElement>('.wf-bar.tool')?.dataset.targetId
    expect(chatToolTarget).toBe('tool:call-1')
    expect(trajectoryToolTarget).toBe(chatToolTarget)
    expect(waterfallToolTarget).toBe(chatToolTarget)
    document.querySelector<HTMLButtonElement>('.wf-bar')!.click()
    expect(document.querySelector('#wfView')?.classList.contains('active')).toBe(true)
    expect(document.querySelector('#trajView')?.classList.contains('active')).toBe(false)
    expect(document.querySelector<HTMLElement>('#inspector')?.hidden).toBe(false)
    expect(document.querySelector('#inspectorKind')?.textContent).toBe('轮次')

    document.querySelector<HTMLButtonElement>('[data-action="jump-traj"]')!.click()
    expect(document.querySelector('#trajView')?.classList.contains('active')).toBe(true)
  })

  it('starts a fresh live skeleton per turn and converges without user action when the persisted trace lags', async () => {
    const prompts: Deferred<unknown>[] = [deferred(), deferred(), deferred()]
    const promptQueue = [...prompts]
    let update: ((payload: unknown) => void) | undefined
    let traceRead: unknown
    const turnEvents = (turn: number, userText: string, answer: string, base: number): unknown[] => [
      { type: 'turn/start', seq: base, time: base + 1, data: { turn, trigger: { kind: 'message' } } },
      { type: 'user/message', seq: base + 1, time: base + 2, data: { content: [{ type: 'text', text: userText }] } },
      { type: 'step/start', seq: base + 2, time: base + 3, data: { turn, step: 1 } },
      { type: 'assistant/message', seq: base + 3, time: base + 4, data: { turn, step: 1, content: [{ type: 'text', text: answer }] } },
      { type: 'step/end', seq: base + 4, time: base + 5, data: { turn, step: 1 } },
      { type: 'turn/end', seq: base + 5, time: base + 6, data: { turn, reason: { kind: 'completed' } } },
    ]
    const trace = (events: unknown[]): unknown => ({ found: true, sessionId: 's-lag', header: { id: 's-lag' }, rawText: '', feedback: [], events })
    const turn1Trace = trace(turnEvents(1, 'first', 'first answer', 0))
    const fullTrace = trace([
      ...turnEvents(1, 'first', 'first answer', 0),
      ...turnEvents(2, 'second', 'second answer', 10),
      ...turnEvents(3, 'third', 'third answer', 20),
      { type: 'tool/call', seq: 30, time: 31, data: { turn: 3, step: 1, callId: 'wf-1', name: 'workflow', arguments: '{"name":"audit"}' } },
      { type: 'tool/result', seq: 31, time: 32, data: { turn: 3, step: 1, callId: 'wf-1', content: [{ type: 'text', text: 'done' }] } },
    ])
    traceRead = turn1Trace

    window.dshDesktop = {
      runtime: {
        start: async () => ({}),
        stop: async () => ({}),
        restart: async () => ({}),
        status: async () => ({ state: 'running', repoRoot: '/repo' }),
        onStatus: () => () => {},
        onStderr: () => () => {},
      },
      sessions: {
        list: async () => ({ sessions: [] }),
        create: async () => ({ sessionId: 's-lag', trace: trace([]) }),
        load: async () => ({}),
        prompt: async () => promptQueue.shift()!.promise,
        cancel: async () => ({}),
        reveal: async () => ({}),
        onUpdate: (callback: (payload: unknown) => void) => {
          update = callback
          return () => {}
        },
      },
      trace: { read: async () => traceRead },
      feedback: { list: async () => [], add: async () => ({}) },
      dev: { status: async () => ({ git: {} }), openPath: async () => ({}) },
    }

    await import('../src/app.ts')
    await vi.waitFor(() => {
      expect(document.querySelector('#composerInput')).not.toBeNull()
    })
    const composer = document.querySelector<HTMLTextAreaElement>('#composerInput')!
    const form = document.querySelector<HTMLFormElement>('#composerForm')!
    const send = (text: string): void => {
      composer.value = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }

    document.querySelector<HTMLButtonElement>('[data-action="new-session"]')!.click()
    send('first')
    prompts[0]!.resolve({ response: {}, trace: turn1Trace })
    await vi.waitFor(() => {
      expect(document.querySelector('#conversation')?.textContent).toContain('first answer')
      expect(document.querySelector('#liveTurn')?.innerHTML).toBe('')
    })

    // Turn 2 finishes but the persisted trace still lags behind: the live turn stays.
    send('second')
    prompts[1]!.resolve({ response: {}, trace: turn1Trace })
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#cancelButton')?.hidden).toBe(true)
    })
    expect(document.querySelector('#liveTurn .user-bubble')?.textContent).toBe('second')

    // A third prompt must never reuse the previous turn's skeleton (swallowed-message regression).
    send('third')
    await vi.waitFor(() => {
      expect(document.querySelector('#liveTurn .user-bubble')?.textContent).toBe('third')
    })
    // The ACP stream carries a richer tool title than the persisted name.
    update?.({ sessionId: 's-lag', update: { sessionUpdate: 'tool_call', toolCallId: 'wf-1', title: 'workflow: run audit agents', status: 'in_progress' } })

    // Once the persisted log catches up, the view converges with no user action.
    prompts[2]!.resolve({ response: {}, trace: turn1Trace })
    traceRead = fullTrace
    await vi.waitFor(() => {
      expect(document.querySelector('#conversation')?.textContent).toContain('third answer')
      expect(document.querySelector('#liveTurn')?.innerHTML).toBe('')
    }, { timeout: 4000 })
    // The live workflow presentation survives the switch to the persisted view.
    expect(document.querySelector('#conversation')?.textContent).toContain('workflow: run audit agents')
  })
})
