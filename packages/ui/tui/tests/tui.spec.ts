import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CombinedAutocompleteProvider, type Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, { agentEvents, assembleContextFor, AgentMessageId, type Agent } from '@deepseek-ai/dsh-agent'
import { type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { GOAL_CHANGE_VERSION, GoalId, renderGoalChange, type GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'
import CommandService, { type CommandInvocation } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, type JsonValue, type SessionEvent, type SessionHeader, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import SkillService, { type SkillDefinition, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session-title'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import SessionReferenceService, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {
  createTuiChat,
  FILE_REFERENCE_PROMPT,
  mountTui,
  renderSkillInvocation,
  resolveTuiConfig,
  type TuiOverlayHost,
  type TuiOverlaySession,
  type TuiRuntime,
} from '../src/index.ts'
import { WorkspaceFileSearch } from '../src/file-autocomplete.ts'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  type TuiHarnessOptions,
} from './harness.ts'
import { TestSessionQueryService } from './session-query.ts'

const UNUSED_TOOL_OUTPUT: ToolDefinition['output'] = {
  schema: { type: 'null' },
  render: () => [],
}

class FakeTerminal implements Terminal {
  columns = 88
  rows = 32
  kittyProtocolActive = false
  output = ''
  title = ''
  progress: boolean[] = []
  started = 0
  stopped = 0
  drainInput = vi.fn(() => Promise.resolve())
  private onInput: (data: string) => void = () => {}
  private onResize: () => void = () => {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started += 1
    this.onInput = onInput
    this.onResize = onResize
  }

  stop(): void {
    this.stopped += 1
  }

  write(data: string): void {
    this.output += data
  }

  moveBy(lines: number): void {
    this.output += `[move:${lines}]`
  }

  hideCursor(): void {
    this.output += '[hide]'
  }

  showCursor(): void {
    this.output += '[show]'
  }

  clearLine(): void {
    this.output += '[clear-line]'
  }

  clearFromCursor(): void {
    this.output += '[clear-rest]'
  }

  clearScreen(): void {
    this.output += '[clear-screen]'
  }

  setTitle(title: string): void {
    this.title = title
  }

  setProgress(active: boolean): void {
    this.progress.push(active)
  }

  send(data: string): void {
    this.onInput(data)
  }

  resize(columns: number, rows = this.rows): void {
    this.columns = columns
    this.rows = rows
    this.onResize()
  }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

async function setup(options: TuiHarnessOptions = {}) {
  const terminal = new FakeTerminal()
  const exit = vi.fn()
  // Let the harness default cwd ('/workspace') stand: a checkout-dependent
  // process.cwd() longer than the 88-column fake terminal pushes the footer
  // token counters off-screen and fails their assertions by location.
  const result = await createTuiTestHarness(terminal, exit, options)
  await tick()
  return result
}

async function dispose(setupResult: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await disposeTuiTestHarness(setupResult)
}

function provideTokenMeter(ctx: Context): void {
  ctx.provide('tokenMeter', {
    measure() {
      return { totalTokens: 0 }
    },
  } as never)
}

/** Minimal advisory-catalog llm stub for tests composing their own context. */
function provideLlmCatalog(ctx: Context): void {
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: () => Promise.resolve([]),
    resolveModelContext: () => Promise.resolve(undefined),
  } as never)
}

describe('TUI config', () => {
  it('defaults every direct-call TUI option', () => {
    expect(resolveTuiConfig(undefined)).toEqual({
      showReasoning: true,
      maxToolOutputLines: 6,
      maxQuestionOptions: 8,
      maxModelOptions: 8,
      maxResumeOptions: 8,
      questionDialogWidth: 200,
      questionDialogMaxHeight: 20,
      modelDialogWidth: 72,
      modelDialogMaxHeight: 20,
      fileSearchMaxResults: 20,
      fileSearchMaxEntries: 10_000,
      fileSearchExcludedDirectories: ['.git', 'node_modules'],
      showHardwareCursor: false,
      color: true,
      truecolor: false,
      title: 'DeepSeek Harness',
    })
    expect(resolveTuiConfig({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      maxModelOptions: 4,
      maxResumeOptions: 5,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      modelDialogWidth: 64,
      modelDialogMaxHeight: 16,
      fileSearchMaxResults: 7,
      fileSearchMaxEntries: 123,
      fileSearchExcludedDirectories: ['.git', 'generated'],
      showHardwareCursor: true,
      color: false,
      truecolor: true,
      title: 'DSH',
    })).toEqual({
      showReasoning: false,
      maxToolOutputLines: 2,
      maxQuestionOptions: 3,
      maxModelOptions: 4,
      maxResumeOptions: 5,
      questionDialogWidth: 60,
      questionDialogMaxHeight: 14,
      modelDialogWidth: 64,
      modelDialogMaxHeight: 16,
      fileSearchMaxResults: 7,
      fileSearchMaxEntries: 123,
      fileSearchExcludedDirectories: ['.git', 'generated'],
      showHardwareCursor: true,
      color: false,
      truecolor: true,
      title: 'DSH',
    })
  })
})

describe('resume command and /resume', () => {
  const RESUME = 'RESUME_SESSION_ID={session} dsh'
  const header = (id: string, createdAt: number, cwd: string): SessionHeader =>
    ({ version: 0, id: SessionId(id), createdAt, cwd })
  const resumeEvents = (
    title: string,
    provider = 'deepseek',
    time = 100,
    reason: TurnEndReason = { kind: 'completed' },
  ): SessionEvent[] => [
    { type: 'turn/start', seq: 0, time, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: time + 1, data: { content: [{ type: 'text', text: 'resume me' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: time + 2, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: time + 3, data: { header: { config: { provider, model: 'model-1' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 4, time: time + 4, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'done' }], provenance: { provider, model: 'model-1' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 5, time: time + 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: time + 6, data: { turn: 1, reason } },
    { type: 'session/title', seq: 7, time: time + 7, data: { title, messageSeqs: [1], source: { kind: 'fallback' } } },
  ]

  it('prints the resume command on exit once the session is persisted', async () => {
    const result = await setup({
      cwd: '/workspace',
      config: { resumeCommand: RESUME },
      sessionPersistence: { list: async () => [header('main-session', 1000, '/workspace')] },
    })
    result.terminal.send('/exit')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('To resume this session: RESUME_SESSION_ID=main-session dsh')
    expect(result.exit).toHaveBeenCalledWith(0)
    await dispose(result)
  })

  it('omits the exit hint when the session is not yet persisted', async () => {
    const result = await setup({ cwd: '/workspace', config: { resumeCommand: RESUME } })
    result.terminal.send('/exit')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).not.toContain('To resume this session')
    expect(result.exit).toHaveBeenCalledWith(0)
    await dispose(result)
  })

  it('omits the exit hint when the session listing fails', async () => {
    const result = await setup({
      cwd: '/workspace',
      config: { resumeCommand: RESUME },
      sessionPersistence: { list: () => Promise.reject(new Error('disk gone')) },
    })
    result.terminal.send('/exit')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).not.toContain('To resume this session')
    expect(result.exit).toHaveBeenCalledWith(0)
    await dispose(result)
  })

  it('opens a newest-active-first searchable selector and Esc clears before cancelling', async () => {
    const older = header('older-session', 500, '/workspace')
    const newer = header('newer-session', 2000, '/workspace')
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const result = await setup({
      cwd: '/workspace',
      config: { resumeCommand: RESUME },
      handoffResume: handoff,
      sessionPersistence: {
        list: async () => [older, newer, header('foreign-session', 3000, '/elsewhere')],
        load: async id => id === newer.id
          ? { meta: newer, events: resumeEvents('Newer product work', 'deepseek', 300) }
          : { meta: older, events: resumeEvents('Older investigation', 'deepseek', 100) },
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    const output = result.terminal.output
    expect(output).toContain('Resume session')
    expect(output).toContain('Newer product work')
    expect(output).toContain('Older investigation')
    expect(output).toContain('current · live')
    expect(output.indexOf('Newer product work')).toBeLessThan(output.indexOf('Older investigation'))
    expect(output).not.toContain('foreign-session')
    result.terminal.send('Older')
    await tick()
    expect(result.terminal.output).toContain('⌕ Older')
    result.terminal.send('\x1b')
    await tick()
    expect(result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session')))
      .not.toContain('⌕ Older')
    result.terminal.send('\x1b')
    await tick()
    expect(handoff).not.toHaveBeenCalled()
    await dispose(result)
  })

  it('handles selector navigation, empty matches, and backspace search edits', async () => {
    const target = header('keyboard-target', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Keyboard target') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[A')
    result.terminal.send('\t')
    result.terminal.send('zz')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('No session matches this search')
    result.terminal.send('\x7f')
    result.terminal.send('\x7f')
    await tick()
    const cleared = result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session'))
    expect(cleared).toContain('⌕ ')
    expect(cleared).not.toContain('zz')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('current session')
    result.terminal.send('\x1b')
    await dispose(result)
  })

  it('sanitizes bracketed-paste terminal controls before storing the search query', async () => {
    const target = header('safe-target', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Safe target') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('\x1b[200~Safe\x1b]0;own')
    result.terminal.send('ed\x07 target\x1b[31m\x1b[201~')
    await tick()
    const rendered = result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session'))
    expect(rendered).toContain('⌕ Safe target')
    expect(rendered).not.toContain('owned')
    expect(rendered).not.toContain('[31m')
    result.terminal.send('\x1b')
    result.terminal.send('Safe\x1b[200~\x1b[201~ target')
    await tick()
    expect(result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session')))
      .toContain('⌕ Safe target')
    await dispose(result)
  })

  it('pages by the number of candidates that fit the current viewport', async () => {
    const targets = Array.from({ length: 8 }, (_, index) =>
      header(`paged-${index}`, 1000 - index, '/workspace'))
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => targets,
        load: async id => ({
          meta: targets.find(target => target.id === id)!,
          events: resumeEvents(`Paged ${id.slice('paged-'.length)}`, 'deepseek', 1000 - Number(id.slice('paged-'.length)) * 10),
        }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('\x1b[6~')
    await tick()
    const rendered = result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session'))
    expect(rendered).toContain('❯ Paged 3')
    result.terminal.send('\x1b[5~')
    await tick()
    expect(result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session')))
      .toContain('❯ Untitled session')
    result.terminal.resize(10)
    await tick()
    expect(result.terminal.output.slice(result.terminal.output.lastIndexOf('Resume session')))
      .toContain('⌕')
    result.terminal.send('\x03')
    await dispose(result)
  })

  it('clips candidate count through the configured visible-session limit', async () => {
    const targets = [header('limited-a', 10, '/workspace'), header('limited-b', 20, '/workspace')]
    const result = await setup({
      cwd: '/workspace',
      config: { maxResumeOptions: 1 },
      sessionPersistence: {
        list: async () => targets,
        load: async id => ({
          meta: targets.find(target => target.id === id)!,
          events: resumeEvents(`Limited ${id}`),
        }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('(1 of 3)')
    await dispose(result)
  })

  it.each([
    [{ kind: 'aborted' }, 'cancelled'],
    [{ kind: 'error', step: 1, message: 'failed' }, 'error'],
    [{ kind: 'disposed' }, 'disposed'],
    [{ kind: 'max-tokens' }, 'max tokens'],
    [{ kind: 'rejected', reason: 'policy' }, 'rejected'],
    [{ kind: 'interrupted' }, 'interrupted'],
    [{ kind: 'future-result' } as unknown as TurnEndReason, 'unknown result'],
  ] as const)('renders the last turn result %s', async (reason, label) => {
    const target = header(`turn-${label}`, 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents(`Turn ${label}`, 'deepseek', 100, reason) }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain(`turn 1: ${label}`)
    await dispose(result)
  })

  it('refuses while running instead of cancelling or switching', async () => {
    const result = await setup({ cwd: '/workspace', status: 'running' })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('finish or be cancelled first')
    expect(result.agent.cancelled).toEqual([])
    await dispose(result)
  })

  it('warns when the optional session-query service is absent', async () => {
    const result = await setup({ cwd: '/workspace', mountSessionQuery: false })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('session query is not mounted')
    await dispose(result)
  })

  it('keeps persisted query records readable without a persistence service', async () => {
    const target = header('query-only-persisted', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', {
          listSessions: () => Promise.resolve([{
            header: target,
            live: false,
            persisted: true,
          }]),
          readSession: () => Promise.resolve({
            session: target,
            events: resumeEvents('Query-only persisted session'),
          }),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('Query-only persisted session')
    expect(result.terminal.output).toContain('persisted')
    expect(result.terminal.output).not.toContain('session cannot be loaded')
    await dispose(result)
  })

  it('contains a session-query scan failure in the current TUI', async () => {
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', {
          listSessions: () => Promise.reject(new Error('index unavailable')),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Resume session scan failed: index unavailable')
    expect(result.terminal.stopped).toBe(0)
    await dispose(result)
  })

  it('supersedes a slower prior selector scan', async () => {
    const first = Promise.withResolvers<SessionRecord[]>()
    let calls = 0
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', {
          listSessions: () => ++calls === 1 ? first.promise : Promise.resolve([]),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    first.reject(new Error('superseded scan failed'))
    await tick()
    expect(calls).toBe(2)
    expect(result.terminal.output).toContain('No matching sessions')
    expect(result.terminal.output).not.toContain('superseded scan failed')
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[B')
    await dispose(result)
  })

  it('drops a selector scan that resolves after TUI disposal', async () => {
    const listing = Promise.withResolvers<SessionRecord[]>()
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', { listSessions: () => listing.promise } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    await dispose(result)
    listing.resolve([])
    await tick()
    expect(result.terminal.stopped).toBeGreaterThan(0)
  })

  it('drops loaded selector summaries when the TUI disposed during log reads', async () => {
    const target = header('dispose-during-load', 10, '/workspace')
    const loading = Promise.withResolvers<{ meta: SessionHeader; events: SessionEvent[] }>()
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: () => loading.promise,
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    await dispose(result)
    loading.resolve({ meta: target, events: resumeEvents('Disposed load') })
    await tick()
    expect(result.terminal.stopped).toBeGreaterThan(0)
  })

  it('preflights route availability and corrupt sessions without losing the current TUI', async () => {
    const missing = header('missing-route', 10, '/workspace')
    const corrupt = header('corrupt', 30, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      config: { resumeCommand: RESUME },
      sessionPersistence: {
        list: async () => [missing, corrupt],
        load: async (id) => {
          if (id === corrupt.id) throw new Error('checksum mismatch')
          return {
            meta: missing,
            events: resumeEvents('Missing adapter', 'absent-provider'),
          }
        },
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('Missing adapter')
    expect(result.terminal.output).toContain('absent-provider/model-1')
    expect(result.terminal.output).toContain('Unreadable session')
    result.terminal.send('Missing adapter')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('route is currently unavailable')
    expect(result.terminal.stopped).toBe(0)
    await dispose(result)
  })

  it('keeps a session already live in this runtime visible but disabled', async () => {
    const target = header('live-target', 10, '/workspace')
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', {
          listSessions: () => Promise.resolve([{
            header: target,
            live: true,
            persisted: true,
          }]),
          readSession: () => Promise.resolve({
            session: target,
            events: resumeEvents('Live target'),
          }),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Live target')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('session is already live in this runtime')
    expect(handoff).not.toHaveBeenCalled()
    await dispose(result)
  })

  it('falls back to assistant provenance and header creation time for sparse logs', async () => {
    const assistantOnly = header('assistant-route', 20, '/workspace')
    const empty = header('empty-log', 10, '/workspace')
    const events = resumeEvents('Assistant route', 'deepseek')
      .filter(event => event.type !== 'request/header')
      .map((event, seq) => ({ ...event, seq })) as SessionEvent[]
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [assistantOnly, empty],
        load: async id => id === assistantOnly.id
          ? { meta: assistantOnly, events }
          : { meta: empty, events: [] },
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('deepseek/model-1')
    expect(result.terminal.output).toContain(new Date(empty.createdAt).toISOString())
    await dispose(result)
  })

  it('flushes, releases the terminal, and invokes one host handoff for the same SessionId', async () => {
    const target = header('target-session', 10, '/workspace')
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>(() => Promise.reject(new Error('test host retained process')))
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Target session') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Target session')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(handoff).toHaveBeenCalledWith(target.id)
    expect(result.terminal.stopped).toBeGreaterThan(0)
    expect(result.terminal.output).toContain('Resume handoff failed: test host retained process')
    await dispose(result)
  })

  it('restores the UI when a host returns instead of replacing the process', async () => {
    const target = header('returning-host', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      handoffResume: async () => undefined as never,
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Returning host') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Returning host')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('resume host returned without replacing the process')
    await dispose(result)
  })

  it('keeps the current TUI when the selected log fails its second preflight load', async () => {
    const target = header('racing-corruption', 10, '/workspace')
    let loads = 0
    const result = await setup({
      cwd: '/workspace',
      handoffResume: vi.fn(),
      sessionPersistence: {
        list: async () => [target],
        load: async () => {
          if (++loads > 1) throw new Error('log changed during selection')
          return { meta: target, events: resumeEvents('Racing corruption') }
        },
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Racing corruption')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('Resume failed: session cannot be loaded: failed to inspect session')
    expect(result.terminal.output).toContain('log changed during selection')
    expect(result.terminal.stopped).toBe(0)
    await dispose(result)
  })

  it('does not flush or hand off when disposal begins during selected-session preflight', async () => {
    const target = header('dispose-during-preflight', 10, '/workspace')
    const secondListing = Promise.withResolvers<SessionRecord[]>()
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const flush = vi.fn()
    let listings = 0
    const record: SessionRecord = { header: target, live: false, persisted: true }
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.on('session/flush', flush)
        ctx.provide('sessionQuery', {
          listSessions: () => ++listings === 1 ? Promise.resolve([record]) : secondListing.promise,
          readSession: () => Promise.resolve({
            session: target,
            events: resumeEvents('Dispose during preflight'),
          }),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick()
    result.terminal.send('Dispose during preflight')
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(listings).toBe(2) })
    await dispose(result)
    secondListing.resolve([record])
    await tick()
    expect(flush).not.toHaveBeenCalled()
    expect(handoff).not.toHaveBeenCalled()
  })

  it('hands off a validated session exposed by a query backend without a persistence service', async () => {
    const target = header('query-without-persistence', 10, '/workspace')
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>(
      () => Promise.reject(new Error('test host retained process')),
    )
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('sessionQuery', {
          listSessions: () => Promise.resolve([{
            header: target,
            live: false,
            persisted: true,
          }]),
          readSession: () => Promise.resolve({
            session: target,
            events: resumeEvents('Query without persistence'),
          }),
        } as never)
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Query without persistence')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(handoff).toHaveBeenCalledWith(target.id)
    expect(result.terminal.output).toContain('Resume handoff failed: test host retained process')
    await dispose(result)
  })

  it('does not hand off after disposal begins during the current-session flush', async () => {
    const target = header('dispose-during-flush', 10, '/workspace')
    const flushing = Promise.withResolvers<undefined>()
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.on('session/flush', () => flushing.promise)
      },
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Dispose during flush') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Dispose during flush')
    result.terminal.send('\r')
    await tick()
    const disposing = dispose(result)
    await tick()
    flushing.resolve(undefined)
    await disposing
    expect(handoff).not.toHaveBeenCalled()
  })

  it('does not hand off after disposal begins while terminal input drains', async () => {
    const target = header('dispose-during-drain', 10, '/workspace')
    const draining = Promise.withResolvers<undefined>()
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Dispose during drain') }),
      },
    })
    result.terminal.drainInput.mockImplementationOnce(() => draining.promise)
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Dispose during drain')
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(result.terminal.drainInput).toHaveBeenCalled() })
    await dispose(result)
    draining.resolve(undefined)
    await tick()
    expect(handoff).not.toHaveBeenCalled()
  })

  it('does not restart the terminal when a pending host rejects during disposal', async () => {
    const target = header('host-rejects-during-disposal', 10, '/workspace')
    const host = Promise.withResolvers<never>()
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>(() => host.promise)
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Host disposal') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Host disposal')
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(handoff).toHaveBeenCalled() })
    const startsBeforeDispose = result.terminal.started
    await dispose(result)
    host.reject(new Error('host rejected after disposal'))
    await tick()
    expect(result.terminal.started).toBe(startsBeforeDispose)
    expect(result.terminal.output).not.toContain('host rejected after disposal')
  })

  it('rejects a candidate whose cwd changes between listing and preflight', async () => {
    const target = header('moving-workspace', 10, '/workspace')
    let listings = 0
    const result = await setup({
      cwd: '/workspace',
      handoffResume: vi.fn(),
      sessionPersistence: {
        list: async () => [++listings <= 2 ? target : header('moving-workspace', 10, '/elsewhere')],
        load: async () => ({
          meta: listings <= 2 ? target : header('moving-workspace', 10, '/elsewhere'),
          events: resumeEvents('Moving workspace'),
        }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Moving workspace')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('different workspace')
    await dispose(result)
  })

  it('admits only one handoff while the selected preflight is pending', async () => {
    const target = header('single-handoff', 10, '/workspace')
    const preflight = Promise.withResolvers<{ meta: SessionHeader; events: SessionEvent[] }>()
    let loads = 0
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: () => ++loads === 1
          ? Promise.resolve({ meta: target, events: resumeEvents('Single handoff') })
          : preflight.promise,
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Single handoff')
    result.terminal.send('\r')
    result.terminal.send('\r')
    await tick()
    preflight.resolve({ meta: target, events: resumeEvents('Single handoff') })
    await tick(); await tick()
    expect(loads).toBe(2)
    await dispose(result)
  })

  it('rechecks running state and candidate existence before loading the selected log', async () => {
    const target = header('preflight-races', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      handoffResume: vi.fn(),
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Preflight races') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.agent.status = 'running'
    result.terminal.send('Preflight races')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Resume requires an idle agent (status: running)')
    result.agent.status = 'idle'
    await dispose(result)

    let disappearingLists = 0
    const disappearing = await setup({
      cwd: '/workspace',
      handoffResume: vi.fn(),
      sessionPersistence: {
        list: async () => ++disappearingLists <= 2 ? [target] : [],
        load: async () => ({ meta: target, events: resumeEvents('Disappearing target') }),
      },
    })
    disappearing.terminal.send('/resume')
    disappearing.terminal.send('\r')
    await tick(); await tick()
    disappearing.terminal.send('Disappearing target')
    disappearing.terminal.send('\r')
    await tick()
    expect(disappearing.terminal.output).toContain('is no longer available')
    await dispose(disappearing)
  })

  it('rechecks idleness after the selected log finishes loading', async () => {
    const target = header('load-turns-running', 10, '/workspace')
    let loads = 0
    const result = await setup({
      cwd: '/workspace',
      handoffResume: vi.fn(),
      sessionPersistence: {
        list: async () => [target],
        load: async () => {
          loads += 1
          if (loads === 2) result.agent.status = 'running'
          return { meta: target, events: resumeEvents('Load turns running') }
        },
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Load turns running')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('Resume requires an idle agent (status: running)')
    result.agent.status = 'idle'
    await dispose(result)
  })

  it('keeps resumeCommand as a displayed fallback when the host cannot hand off', async () => {
    const target = header('fallback-session', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      config: { resumeCommand: RESUME },
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Fallback target') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Fallback target')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('This host cannot hand off in place. Exit and run:')
    expect(result.terminal.output).toContain('RESUME_SESSION_ID=fallback-session')
    expect(result.terminal.stopped).toBe(0)
    await dispose(result)
  })

  it('keeps the selector independent from an absent command fallback', async () => {
    const target = header('no-fallback-session', 10, '/workspace')
    const result = await setup({
      cwd: '/workspace',
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('No fallback target') }),
      },
    })
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('No fallback target')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Session is resumable, but this host cannot hand it off in place')
    await dispose(result)
  })

  it('rechecks idleness after the current-session flush', async () => {
    const target = header('post-flush-running', 10, '/workspace')
    const control: { setRunning?: () => void } = {}
    const handoff = vi.fn<NonNullable<TuiRuntime['handoffResume']>>()
    const result = await setup({
      cwd: '/workspace',
      handoffResume: handoff,
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.on('session/flush', () => { control.setRunning?.() })
      },
      sessionPersistence: {
        list: async () => [target],
        load: async () => ({ meta: target, events: resumeEvents('Post-flush running') }),
      },
    })
    control.setRunning = () => { result.agent.status = 'running' }
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    result.terminal.send('Post-flush running')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('Resume requires an idle agent (status: running)')
    expect(handoff).not.toHaveBeenCalled()
    result.agent.status = 'idle'
    await dispose(result)
  })
})

describe('pi-tui chat lifecycle and transcript', () => {
  it('restores durable goal phase without implying automatic continuation', async () => {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'create',
      goal: {
        id: GoalId('restored-goal'),
        revision: 1,
        objective: 'Resume only with human confirmation',
        phase: 'active',
        maxGoalRounds: 4,
      },
      roundsStarted: 0,
      createdAt: 10,
      updatedAt: 10,
    }
    const result = await setup({
      beforeMount(session) {
        session.append('user/message', {
          content: renderGoalChange(change),
          source: { kind: 'goal', goalId: change.goal.id, revision: change.goal.revision, round: 0 },
          meta: change as unknown as JsonValue,
        }, { surfaceOp: 'append' })
      },
    })
    expect(result.terminal.output).toContain('Goal restored (active) with automatic continuation disarmed')
    expect(result.terminal.output).toContain('/goal resume')
    result.terminal.send('/resume')
    result.terminal.send('\r')
    await tick(); await tick()
    expect(result.terminal.output).toContain('goal active')
    await dispose(result)
  })

  it('uses the latest log-backed title for the header subtitle and terminal window', async () => {
    const result = await setup({
      // A fixed short cwd keeps the footer's token counters inside the 88-column
      // fake terminal regardless of where the checkout lives; cwd rendering has
      // its own dedicated variants test below.
      cwd: '/workspace',
      beforeMount(session) {
        session.append('session/title', {
          title: 'Restored session title',
          messageSeqs: [1],
          source: { kind: 'fallback' },
        })
      },
    })

    expect(result.terminal.title).toBe('Restored session title — DeepSeek Harness')
    expect(result.terminal.output).toContain('Restored session title')
    expect(result.terminal.output).not.toContain('Coding agent ready.')

    result.session.append('session/title', {
      title: 'Live title \u001B]0;unsafe\u0007',
      messageSeqs: [1, 5],
      source: { kind: 'fallback' },
    })
    await tick()

    expect(result.terminal.title).toContain('Live title \\x1b]0;unsafe\\x07 — DeepSeek Harness')
    expect(result.terminal.title).not.toContain('\u001B')
    expect(result.terminal.output).toContain('Live title \\x1b]0;unsafe\\x07')
    await dispose(result)
  })

  it('renders its header, footer, replay, streaming answer, todos, and status', async () => {
    let now = 0
    const result = await setup({
      contextWindow: 100,
      contextTokens: 42,
      // Short cwd: the footer clips its right (context/tools) segment first,
      // and the default worktree path would swallow it at 88 columns.
      cwd: '/opt',
      now: () => now,
      beforeMount(session) {
        appendUser(session, 'restored prompt')
        appendAssistant(session, [
          { type: 'reasoning', text: 'restored thought' },
          { type: 'text', text: '**restored answer**' },
        ], { inputTokens: 1_250, outputTokens: 42 })
        session.append('todo/write', {
          todos: [
            { content: 'read code', status: 'completed' },
            { content: 'write tests', status: 'in_progress' },
            { content: 'ship', status: 'pending' },
          ],
        })
      },
    })

    expect(result.terminal.started).toBe(1)
    expect(result.terminal.title).toBe('DeepSeek Harness')
    expect(result.terminal.output).toContain('DEEPSEEK')
    expect(result.terminal.output).toContain('Coding agent ready.')
    expect(result.terminal.output).toContain('restored prompt')
    expect(result.terminal.output).toContain('restored thought')
    expect(result.terminal.output).toContain('restored answer')
    expect(result.terminal.output).toContain('write tests')
    expect(result.terminal.output).toContain('↑1.3k ↓42')
    // Context resolution is async (resolveModelContext); settle before reading.
    await tick()
    expect(result.terminal.output).toContain('42% context  tools:collapsed')
    // Narrow terminals clip the right-hand context/tools segment first; the
    // model-led left segment stays.
    result.terminal.resize(52)
    await tick()
    expect(result.terminal.output).toContain('deepseek-v4-flash')
    result.terminal.resize(88)
    await tick()

    result.agent.status = 'running'
    agentEvents(result.ctx, result.agent).emit('agent/status', 'running')
    now = 8_000
    result.session.append('user/message', { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: 'steering note' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('steering/message', { turn: 2, content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    result.session.append('user/message', { content: [{ type: 'text', text: 'user context' }], source: { kind: 'plugin', plugin: 'ctx' } }, { surfaceOp: 'append' })
    result.session.append('user/message', { content: [{ type: 'text', text: '' }], source: { kind: 'plugin', plugin: 'ctx' } }, { surfaceOp: 'append' })
    // A non-plugin injected source (goal) has no `plugin` field, so its context
    // card label falls back to the source kind.
    result.session.append('user/message', { content: [{ type: 'text', text: 'goal context' }], source: { kind: 'goal', goalId: 'g1', revision: 1, round: 0 } as never }, { surfaceOp: 'append' })
    result.session.append('prompt/blocked', { content: [{ type: 'text', text: 'blocked' }], source: { kind: 'user' }, reason: 'test policy' })
    appendAssistant(result.session, [])
    result.session.append('step/end', { turn: 1, step: 1 })
    result.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    result.session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    result.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    result.session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })
    result.session.append('step/start', { turn: 3, step: 1 })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: 'live thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 9, text: 'unannounced thought' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'live thought complete' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 1, blockType: 'text' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'text-delta', index: 1, text: 'live answer' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'live answer done' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-start', index: 2, blockType: 'tool-call' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'stream-tool' as never, name: 'tool', arguments: '{}' } },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 2, id: 'stream-tool' as never, argumentsDelta: '{}' },
    })
    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    })
    await tick()
    expect(result.terminal.output).toContain('live thought')
    result.terminal.send('\x12')
    await tick()
    appendAssistant(
      result.session,
      [{ type: 'text', text: 'final live answer' }],
      { inputTokens: 500, outputTokens: 8 },
      { turn: 3, step: 1 },
    )
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('final live answer')
    })

    expect(result.terminal.output).toContain('Enter sends steering, Esc cancels')
    expect(result.terminal.output).toContain('Steering')
    expect(result.terminal.output).toContain('user context')
    expect(result.terminal.output).toContain('Context · goal') // goal-sourced injected context labels by kind
    expect(result.terminal.output).toContain('Prompt blocked')
    expect(result.terminal.output).toContain('Turn cancelled')
    expect(result.terminal.progress).toContain(true)

    result.session.append('assistant/chunk', {
      turn: 3,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'cleared stream' },
    })
    result.terminal.send('/clear')
    result.terminal.send('\r')
    appendAssistant(result.session, [{ type: 'text', text: 'answer after clear' }], undefined, { turn: 3, step: 1 })
    await tick()
    expect(result.terminal.output).toContain('answer after clear')

    result.agent.status = 'idle'
    agentEvents(result.ctx, result.agent).emit('agent/status', 'idle')
    await tick()
    expect(result.terminal.output).toContain('↑1.8k ↓50')
    expect(result.terminal.output).toContain('deepseek-v4-flash')
    expect(result.terminal.progress.at(-1)).toBe(false)
    await dispose(result)
    expect(result.terminal.stopped).toBe(1)
    expect(result.terminal.drainInput).toHaveBeenCalledWith(100, 20)
  })

  it('counts failed and recovered request usage once per step', async () => {
    const result = await setup()
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'temporary', code: 'SERVER' },
    })
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
    })
    appendAssistant(
      result.session,
      [{ type: 'text', text: 'recovered' }],
      { inputTokens: 7, outputTokens: 3 },
      { turn: 1, step: 2 },
    )
    await tick()

    expect(result.terminal.output).toContain('↑17 ↓5')
    await dispose(result)
  })

  it('retracts a failed live stream and renders its durable retry status', async () => {
    const result = await setup()
    result.session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'discarded partial answer' },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 1,
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
    })
    result.session.append('llm/retry', {
      turn: 1,
      step: 2,
      retry: 2,
      maxRetries: 2,
      delayMs: 1_000,
      failure: { message: 'failed before chunks', code: 'SERVER', status: 503 },
    })
    await tick()

    expect(result.terminal.output).toContain('Retrying model request (1/2) in 500ms: rate limited')
    expect(result.terminal.output).toContain('Retrying model request (2/2) in 1000ms: failed before chunks')
    await dispose(result)
  })

  it('badges queued steering on the running status line and clears it as each drains', async () => {
    // Pin a cwd free of the substring under test; the footer renders the path.
    const result = await setup({ status: 'running', cwd: '/workspace' })
    // Running with nothing queued: the plain steering hint, no badge.
    expect(result.terminal.output).toContain('— Enter sends steering, Esc cancels')
    expect(result.terminal.output).not.toContain('queued')

    const queueSteering = (text: string): void => {
      result.ctx.emit('agent/inbox/enqueue', result.agent, { id: AgentMessageId('stub'), content: [{ type: 'text', text }], source: { kind: 'user' }, contexts: [], steering: true, wakeup: true })
    }
    const drainSteering = (text: string): void => {
      result.session.append('steering/message', { turn: 1, content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    }

    // A steering queue for a different agent never touches this status line.
    const other = { ...result.agent, id: SessionId('other') } as unknown as Agent
    result.terminal.output = ''
    result.ctx.emit('agent/inbox/enqueue', other, { id: AgentMessageId('stub'), content: [{ type: 'text', text: 'elsewhere' }], source: { kind: 'user' }, contexts: [], steering: true, wakeup: true })
    await tick()
    expect(result.terminal.output).not.toContain('queued')

    // Two steering messages queue while the turn runs.
    queueSteering('first')
    result.terminal.output = ''
    queueSteering('second')
    await tick()
    expect(result.terminal.output).toContain('2 queued · Enter sends steering, Esc cancels')

    // A non-steering queue (an idle-style send) leaves the badge untouched.
    result.terminal.output = ''
    result.ctx.emit('agent/inbox/enqueue', result.agent, { id: AgentMessageId('stub'), content: [{ type: 'text', text: 'sent' }], source: { kind: 'user' }, contexts: [], steering: false, wakeup: true })
    drainSteering('first')
    await tick()
    expect(result.terminal.output).toContain('1 queued')
    expect(result.terminal.output).not.toContain('2 queued')

    // Draining the last queued message returns the plain hint.
    result.terminal.output = ''
    drainSteering('second')
    await tick()
    expect(result.terminal.output).toContain('— Enter sends steering, Esc cancels')
    expect(result.terminal.output).not.toContain('queued')

    // A drain with no matching queued entry is ignored rather than underflowing.
    result.terminal.output = ''
    drainSteering('continuation')
    queueSteering('after')
    await tick()
    expect(result.terminal.output).toContain('1 queued')

    // A steering/message whose source matches no pending badge entry (here a
    // plugin source with no tracked enqueue) pops nothing, so it cannot consume
    // a pending user slot even when it drains first.
    result.terminal.output = ''
    result.session.append('steering/message', {
      turn: 1,
      content: [{ type: 'text', text: 'continue: goal not reached' }],
      source: { kind: 'plugin', plugin: 'hooks' },
    }, { surfaceOp: 'append' })
    await tick()
    expect(result.terminal.output).toContain('1 queued')
    result.terminal.output = ''
    drainSteering('after')
    await tick()
    expect(result.terminal.output).not.toContain('queued')

    // The turn ending resets the badge, so the next running turn starts clean.
    result.agent.status = 'idle'
    result.ctx.emit('agent/status', result.agent, 'idle')
    result.agent.status = 'running'
    result.terminal.output = ''
    result.ctx.emit('agent/status', result.agent, 'running')
    await tick()
    expect(result.terminal.output).toContain('— Enter sends steering, Esc cancels')
    expect(result.terminal.output).not.toContain('queued')

    await dispose(result)
  })

  it('derives the fine-grained turn phase from session lifecycle events', async () => {
    // A live event before the turn runs has no status controller to move.
    const idle = await setup()
    // A steering queue arriving while idle has no status line to badge, so the
    // refresh is a no-op beyond requesting a render.
    idle.ctx.emit('agent/inbox/enqueue', idle.agent, { id: AgentMessageId('stub'), content: [{ type: 'text', text: 'early' }], source: { kind: 'user' }, contexts: [], steering: true, wakeup: true })
    idle.session.append('tool/call', { turn: 1, step: 0, callId: 'pre' as never, name: 'bash', arguments: '{}' })
    await tick()
    expect(idle.terminal.output).not.toContain('Executing tools')
    expect(idle.terminal.output).not.toContain('queued')
    await dispose(idle)

    const result = await setup({ status: 'running' })
    expect(result.terminal.output).toContain('Waiting for the first token')

    result.terminal.output = ''
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'mull it over' } })
    await tick()
    expect(result.terminal.output).toContain('Thinking')

    result.terminal.output = ''
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-start', index: 1, blockType: 'text' } })
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 1, text: 'answering' } })
    await tick()
    expect(result.terminal.output).toContain('Responding')

    result.terminal.output = ''
    result.session.append('tool/call', { turn: 1, step: 0, callId: 'c1' as never, name: 'bash', arguments: '{}' })
    await tick()
    expect(result.terminal.output).toContain('Executing tools')

    // The next step reopens the wait window and resets the executing label.
    result.terminal.output = ''
    result.session.append('step/start', { turn: 1, step: 1 })
    await tick()
    expect(result.terminal.output).toContain('Waiting for the first token')
    expect(result.terminal.output).not.toContain('Executing tools')

    await dispose(result)
  })

  it('refreshes the running status elapsed time on its own timer', async () => {
    let now = 0
    const intervals = vi.spyOn(globalThis, 'setInterval')
    let result: Awaited<ReturnType<typeof setup>> | undefined
    try {
      result = await setup({ status: 'running', now: () => now })
      const refresh = intervals.mock.calls.find(([, interval]) => interval === 1_000)?.[0]
      if (typeof refresh !== 'function') throw new Error('TUI did not register its elapsed-status refresh interval')
      result.terminal.output = ''
      // The loader repaints "0s" until the controller's own interval fires; a
      // non-zero elapsed proves the refresh, not just the loader's animation.
      now = 1_000
      refresh()
      await tick()
      expect(result.terminal.output).toContain('Waiting for the first token 1s')
    } finally {
      if (result !== undefined) await dispose(result)
      intervals.mockRestore()
    }
  })

  it('shows minutes and seconds once a step passes a minute', async () => {
    const result = await setup({ status: 'running' })
    const base = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base + 95_000)
    result.terminal.output = ''
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } })
    await tick()
    expect(result.terminal.output).toContain('total 1m')
    nowSpy.mockRestore()
    await dispose(result)
  })

  it('preserves the turn phase and elapsed time across a mid-turn color-scheme change', async () => {
    const result = await setup({ status: 'running' })
    const base = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    // Advance into `responding`, anchoring the phase clock at `base`.
    result.session.append('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'answering' } })
    await tick()

    // Four seconds later the terminal reports a light color scheme, rebuilding
    // the status loader; the phase and its elapsed time must survive the rebuild.
    nowSpy.mockReturnValue(base + 4_000)
    result.terminal.output = ''
    result.terminal.send('\x1b[?997;2n')
    await tick()
    await tick()
    expect(result.terminal.output).toContain('Responding 4s')
    expect(result.terminal.output).not.toContain('Waiting for the first token')

    nowSpy.mockRestore()
    await dispose(result)
  })

  it('renders the ANSI palette and every markdown/content style', async () => {
    const result = await setup({
      cwd: '/workspace',
      config: { color: true },
      beforeMount(session) {
        session.append('user/message', {
          content: [
            { type: 'text', text: '# Heading\n\n[link](https://example.com) `code`\n\n```ts\nconst x = 1\n```\n\n> quote\n\n---\n\n- item\n\n**bold** *italic* ~~strike~~' },
            { type: 'tool-call', id: 'nested' as never, name: 'nested_tool', arguments: '{}' },
            { type: 'tool-result', toolCallId: 'nested' as never, content: [{ type: 'reasoning', text: 'nested result' }] },
            { type: 'future-block' } as never,
            {} as never,
          ],
          source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        appendAssistant(session, [
          { type: 'reasoning', text: 'styled reasoning' },
          { type: 'text', text: 'styled answer' },
        ], { inputTokens: 2_000_000, outputTokens: 1_500_000 })
        session.append('todo/write', { todos: [
          { content: 'done', status: 'completed' },
          { content: 'active', status: 'in_progress' },
          { content: 'later', status: 'pending' },
        ] })
      },
    })
    result.terminal.send('/')
    await tick()
    result.terminal.send('zz')
    await tick()
    result.terminal.send('\x0c')
    await tick()

    expect(result.terminal.output).toContain('\x1b[')
    expect(result.terminal.output).toContain('Heading')
    expect(result.terminal.output).toContain('nested_tool({})')
    expect(result.terminal.output).toContain('nested result')
    expect(result.terminal.output).toContain('[future-block]')
    expect(result.terminal.output).toContain('[content]')
    expect(result.terminal.output).toContain('↑2.0m ↓1.5m')
    await dispose(result)
  })

  it('suppresses stale replay chunks and does not duplicate editor history on rebuild', async () => {
    const result = await setup({
      beforeMount(session) {
        appendUser(session, 'first prompt')
        appendUser(session, 'second prompt')
        session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'stale partial response' },
        })
      },
    })

    expect(result.terminal.output).not.toContain('stale partial response')
    result.terminal.send('/reasoning')
    result.terminal.send('\r')
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[A')
    result.terminal.send('\r')
    expect(result.agent.sent).toEqual([[{ type: 'text', text: 'first prompt' }]])
    await dispose(result)
  })

  it('formats large token totals and cwd variants', async () => {
    const home = homedir()
    const homeResult = await setup({
      cwd: home,
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'home' }], { inputTokens: 25_000, outputTokens: 10_000 })
      },
    })
    await vi.waitFor(() => {
      expect(homeResult.terminal.output).toContain('~  ↑25k ↓10k')
    })
    await dispose(homeResult)

    const childResult = await setup({ cwd: join(home, 'projects', 'dsh-tui') })
    await vi.waitFor(() => {
      expect(childResult.terminal.output).toContain(join('~', 'projects', 'dsh-tui'))
    })
    await dispose(childResult)

    const unsetResult = await setup({ cwd: null })
    await vi.waitFor(() => {
      expect(unsetResult.terminal.output).toContain('cwd unset')
    })
    await dispose(unsetResult)

    const homeParent = resolve(home, '..')
    const parentResult = await setup({ cwd: homeParent })
    await vi.waitFor(() => {
      expect(parentResult.terminal.output).toContain(homeParent)
    })
    await dispose(parentResult)

    const outsideResult = await setup({ cwd: '/opt' })
    await vi.waitFor(() => {
      expect(outsideResult.terminal.output).toContain('/opt')
    })
    await dispose(outsideResult)

    const logicalResult = await setup({
      cwd: '/w',
      formatCwd: cwd => `logical:${cwd}\x1b`,
    })
    await vi.waitFor(() => {
      expect(logicalResult.terminal.output).toContain('logical:/w\\x1b')
    })
    await dispose(logicalResult)
  })

  it('shows the session cache hit rate in the footer and updates it live', async () => {
    // Empty session: no input billed yet, so the cache segment is hidden.
    // A cwd without "cache" in it keeps the negative assertion unambiguous.
    const empty = await setup({ cwd: '/opt' })
    expect(empty.terminal.output).toContain('↑0 ↓0')
    expect(empty.terminal.output).not.toContain('cache')
    await dispose(empty)

    const result = await setup({
      // Pin a short cwd so the footer never clips the cache segment: the
      // default is process.cwd(), and a deep worktree path truncates
      // `cache 60%` at the terminal width.
      cwd: '/opt',
      beforeMount(session) {
        // Cold call: 10 billed input tokens, none served from cache.
        appendAssistant(session, [{ type: 'text', text: 'cold' }], { inputTokens: 10, outputTokens: 5 })
      },
    })
    expect(result.terminal.output).toContain('cache 0%')

    result.terminal.output = ''
    // Warm call lands live on the next step (same-step usage replaces rather
    // than accumulates): 5 uncached + 30 cache-read + 5 cache-write billed
    // input, so 30 of the 50 total prompt tokens are hits → 60%.
    appendAssistant(result.session, [{ type: 'text', text: 'warm' }], {
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    }, { turn: 1, step: 2 })
    await tick()
    expect(result.terminal.output).toContain('cache 60%')
    expect(result.terminal.output).not.toContain('cache 0%')
    await dispose(result)
  })

  it('shows detailed session diagnostics while the agent is running', async () => {
    const timestamp = Date.parse('2026-07-22T09:10:11.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(timestamp)
    const result = await setup({
      cwd: '/workspace/status',
      contextWindow: 128_000,
      contextTokens: 42_000,
      config: { showReasoning: false },
      agentOptions: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      beforeMount(session) {
        session.append('session/title', {
          title: 'Inspect status \u001B]2;unsafe\u0007',
          messageSeqs: [1],
          source: { kind: 'fallback' },
        })
        appendAssistant(session, [{ type: 'text', text: 'measured' }], {
          inputTokens: 1_250,
          outputTokens: 340,
          cacheReadTokens: 3_000,
          cacheWriteTokens: 250,
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: 'status-call-1' as never, name: 'read', arguments: '{}',
        })
        session.append('tool/call', {
          turn: 1, step: 1, callId: 'status-call-2' as never, name: 'write', arguments: '{}',
        })
      },
    })
    result.agent.status = 'running'
    agentEvents(result.ctx, result.agent).emit('agent/status', 'running')
    result.terminal.send('/status')
    result.terminal.send('\r')
    await tick()

    expect(result.terminal.output).toContain('Session status')
    expect(result.terminal.output).toContain('main-session')
    expect(result.terminal.output).toContain('Inspect status \\x1b]2;unsafe\\x07')
    expect(result.terminal.output).toContain('/workspace/status')
    expect(result.terminal.output).toContain('deepseek/deepseek-v4-pro (reasoning hidden)')
    expect(result.terminal.output).toContain('running · 6 events · 1 turn · 1 step · 2 tool calls')
    expect(result.terminal.output).toContain('1,250 input + 340 output')
    expect(result.terminal.output).toContain('[███████████░░░░░] 67% hit (3,000 read + 250 write)')
    expect(result.terminal.output).toContain('[█████░░░░░░░░░░░] 33% used (42,000 / 128,000)')
    expect(result.terminal.output).toContain('2026-07-22 09:10:11 UTC')
    expect(result.terminal.output).not.toContain('\u001B]2;unsafe\u0007')

    result.terminal.resize(56)
    result.terminal.send('/redraw')
    result.terminal.send('\r')
    await tick()

    await dispose(result)
    dateNow.mockRestore()
  })

  it('labels unavailable status diagnostics without inventing values', async () => {
    const timestamp = Date.parse('2026-07-22T10:11:12.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(timestamp)
    const result = await setup({
      cwd: null,
      omitInitialLifecycle: true,
      contextTokens: 7,
      agentOptions: {},
      catalog: {
        providers: [],
        models: [],
        resolveModelContext: () => Promise.resolve(undefined),
      },
    })
    result.terminal.send('/status')
    result.terminal.send('\r')
    await tick()

    expect(result.terminal.output).toContain('untitled')
    expect(result.terminal.output).toContain('unset (reasoning shown)')
    expect(result.terminal.output).toContain('idle · 0 events · 0 turns · 0 steps · 0 tool calls')
    expect(result.terminal.output).toContain('n/a (0 read + 0 write)')
    expect(result.terminal.output).toContain('7 used · capacity unknown')
    expect(result.terminal.output).toContain('2026-07-22 10:11:12 UTC')
    await dispose(result)
    dateNow.mockRestore()
  })

  it('sends, steers, handles commands, global keys, and disposed-agent input', async () => {
    const result = await setup()

    result.terminal.send('do the work')
    result.terminal.send('\r')
    expect(result.agent.sent).toEqual([[{ type: 'text', text: 'do the work' }]])

    result.terminal.send('   ')
    result.terminal.send('\r')

    result.agent.status = 'running'
    result.ctx.emit('agent/status', result.agent, 'running')
    result.terminal.send('steer it')
    result.terminal.send('\r')
    expect(result.agent.steered).toEqual([[{ type: 'text', text: 'steer it' }]])

    result.terminal.send('\x1b')
    result.terminal.send('\x04')
    result.terminal.send('\x03')
    result.terminal.send('\x12')
    result.terminal.send('\x0f')
    expect(result.agent.cancelled).toContainEqual({ kind: 'user' })

    result.agent.status = 'idle'
    for (const command of ['/help', '/reasoning', '/tools', '/redraw', '/reload']) {
      result.terminal.send(command)
      result.terminal.send('\r')
      await tick()
    }
    for (const command of ['/clear', '/wat']) {
      result.terminal.send(command)
      result.terminal.send('\r')
    }
    await tick()
    result.terminal.send('draft')
    result.terminal.send('\x03')
    result.terminal.send('\x04')
    await tick()

    expect(result.terminal.output).toContain('Keyboard shortcuts')
    expect(result.terminal.output).toContain('Reasoning blocks')
    expect(result.terminal.output).toContain('Tool cards')
    expect(result.terminal.output).toContain('Unknown command')
    // /reload without a Loader in the context degrades to a warning.
    expect(result.terminal.output).toContain('/reload needs the cordis Loader')
    expect(result.exit).toHaveBeenCalledWith(0)
    await result.controller.dispose()
    await result.ctx.fiber.dispose()

    const ctrlCExit = await setup()
    ctrlCExit.terminal.send('\x03')
    await tick()
    expect(ctrlCExit.exit).toHaveBeenCalledWith(0)
    await ctrlCExit.controller.dispose()
    await ctrlCExit.ctx.fiber.dispose()

    const disposedAgent = await setup()
    disposedAgent.agent.status = 'disposed'
    disposedAgent.terminal.send('late input')
    disposedAgent.terminal.send('\r')
    await tick()
    expect(disposedAgent.terminal.output).toContain('is disposed')
    await dispose(disposedAgent)
  })

  it('combines session autocomplete with files and prepares send/steer references asynchronously', async () => {
    let sourceId = SessionId('uninitialized')
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
        const source = ctx.sessions.create(SessionId('source-session'), { meta: { cwd: process.cwd(), createdAt: 1 } })
        sourceId = source.id
        appendUser(source, 'source background')
        source.append('session/title', {
          title: 'Source chat',
          messageSeqs: [0],
          source: { kind: 'fallback' },
        })
        ctx.sessions.create(SessionId('no-cwd'), { meta: { createdAt: 2 } })
      },
    })

    result.terminal.send('@no-cwd')
    await vi.waitFor(() => { expect(result.terminal.output).toContain('Session · no-cwd') })
    expect(result.terminal.output).toContain('(no cwd)')
    result.terminal.send('\x03')

    result.terminal.send('@source-session')
    await vi.waitFor(() => { expect(result.terminal.output).toContain('Session · Source chat') })
    expect(result.terminal.output).toContain('source-session')
    result.terminal.send('\t')
    await tick()
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(result.agent.sent).toHaveLength(1) })
    expect(result.agent.sent).toEqual([[{ type: 'text', text: '@Source chat' }]])
    expect(result.agent.sentOptions[0]?.contexts).toHaveLength(1)

    const mention = formatSessionReferenceMention({ sessionId: sourceId, label: 'Source chat' })
    expect(result.agent.sentOptions[0]?.contexts).toMatchObject([{
      source: { kind: 'plugin', plugin: 'session-reference' },
      meta: { kind: 'session-reference', references: [{ sessionId: 'source-session' }] },
    }])

    result.agent.status = 'running'
    result.terminal.send(`steer ${mention}`)
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(result.agent.steered).toHaveLength(1) })
    expect(result.agent.steered).toEqual([[{ type: 'text', text: 'steer @Source chat' }]])
    expect(result.agent.steeredOptions[0]?.contexts).toHaveLength(1)
    await dispose(result)
  })

  it('fuzzy-completes files and directories while sending only the selected path text', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-file-completion-'))
    await mkdir(join(cwd, 'src'), { recursive: true })
    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(join(cwd, 'src', 'source-file.ts'), 'export const source = true\n')
    await writeFile(join(cwd, 'docs', 'design notes.md'), '# Design\n')
    await writeFile(join(cwd, 'unsafe\nfile.ts'), 'unsafe name\n')
    const result = await setup({
      cwd,
      tools: {
        read: {
          name: 'read',
          description: 'Read a file.',
          parameters: {},
          output: UNUSED_TOOL_OUTPUT,
          execute: () => Promise.resolve([]),
        },
      },
    })
    try {
      const assembly = await result.ctx.systemPrompt.assemble(assembleContextFor(result.agent))
      expect(assembly.sections).toContainEqual({
        name: 'ui:tui-file-reference',
        text: FILE_REFERENCE_PROMPT,
      })

      result.terminal.send('@sfts')
      await vi.waitFor(() => {
        expect(result.terminal.output).toContain('File · source-file.ts')
      })
      expect(result.terminal.output).toContain('src/source-file.ts')
      result.terminal.send('\t')
      await tick()
      result.terminal.send('\r')
      await vi.waitFor(() => { expect(result.agent.sent).toHaveLength(1) })
      expect(result.agent.sent[0]).toEqual([{ type: 'text', text: '@src/source-file.ts' }])
      expect(result.agent.sentOptions[0]?.contexts).toEqual([])

      result.terminal.send('@do')
      await vi.waitFor(() => {
        expect(result.terminal.output).toContain('Folder · docs/')
      })
      result.terminal.send('\t')
      result.terminal.output = ''
      result.terminal.send('\t')
      await vi.waitFor(() => {
        expect(result.terminal.output).toContain('@"docs/design notes.md"')
      })
      await tick()
      result.terminal.send('\r')
      await vi.waitFor(() => { expect(result.agent.sent).toHaveLength(2) })
      expect(result.agent.sent[1]).toEqual([{ type: 'text', text: '@"docs/design notes.md"' }])
      expect(result.agent.sentOptions[1]?.contexts).toEqual([])

      result.terminal.send('@unsafe')
      await tick()
      expect(result.terminal.output).not.toContain('File · unsafe')
      result.terminal.send('\x03')
    } finally {
      await result.controller.dispose()
      const assembly = await result.ctx.systemPrompt.assemble(assembleContextFor(result.agent))
      expect(assembly.sections).not.toContainEqual({
        name: 'ui:tui-file-reference',
        text: FILE_REFERENCE_PROMPT,
      })
      await result.ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('isolates failed file discovery from editor autocomplete', async () => {
    const list = vi.spyOn(WorkspaceFileSearch.prototype, 'list').mockRejectedValue(new Error('search failed'))
    const result = await setup()
    try {
      result.terminal.send('@failed')
      await vi.waitFor(() => { expect(list).toHaveBeenCalled() })
      await tick()
      expect(result.agent.sent).toEqual([])
    } finally {
      list.mockRestore()
      await dispose(result)
    }
  })

  it('shows file-reference guidance only while read is visible to the agent', async () => {
    const read: ToolDefinition = {
      name: 'read',
      description: 'Read a file.',
      parameters: {},
      output: UNUSED_TOOL_OUTPUT,
      execute: () => Promise.resolve([]),
    }
    let visibility: 'none' | 'global' | 'agent' = 'none'
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', {
          get(name: string, scope?: Agent) {
            if (name !== 'read' || visibility === 'none') return undefined
            return (scope === undefined) === (visibility === 'global') ? read : undefined
          },
        } as never)
      },
    })
    const fileReferenceText = async (): Promise<string | undefined> => {
      const assembly = await result.ctx.systemPrompt.assemble(assembleContextFor(result.agent))
      return assembly.sections.find(section => section.name === 'ui:tui-file-reference')?.text
    }
    try {
      expect(await fileReferenceText()).toBe('')
      visibility = 'global'
      expect(await fileReferenceText()).toBe('')
      visibility = 'agent'
      expect(await fileReferenceText()).toBe(FILE_REFERENCE_PROMPT)
      visibility = 'none'
      expect(await fileReferenceText()).toBe('')
    } finally {
      await dispose(result)
    }
  })

  it('escapes session autocomplete metadata while preserving the referenced session id', async () => {
    const unsafeId = SessionId('evil\x1b\x07\u009b\ns')
    const unsafeCwd = '/x/\x1b\x07\u009b\nf'
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
        const source = ctx.sessions.create(unsafeId, { meta: { cwd: unsafeCwd, createdAt: 1 } })
        appendUser(source, 'safe background')
      },
    })

    result.terminal.send('@evil')
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('Session · evil\\x1b\\x07\\x9b\\x0a')
    })
    expect(result.terminal.output).toContain('/x/\\x1b\\x07\\x9b\\x0af')
    expect(result.terminal.output).not.toContain('evil\x1b\x07')
    expect(result.terminal.output).not.toContain('/x/\x1b\x07')

    result.terminal.send('\t')
    await tick()
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(result.agent.sent).toHaveLength(1) })
    expect(result.agent.sent).toEqual([[
      { type: 'text', text: '@evil\\x1b\\x07\\x9b\\x0as' },
    ]])
    expect(result.agent.sentOptions[0]?.contexts).toMatchObject([{
      meta: { references: [{ sessionId: unsafeId }] },
    }])
    await dispose(result)
  })

  it('falls back cleanly for non-session, empty, failed, and superseded autocomplete requests', async () => {
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
      },
    })
    const originalListCandidates = result.ctx.sessionReferences.listCandidates.bind(result.ctx.sessionReferences)
    const listCandidates = vi.spyOn(result.ctx.sessionReferences, 'listCandidates')

    result.terminal.send('plain')
    result.terminal.send('\t')
    await tick()
    result.terminal.send('\x03')

    result.terminal.send('/he')
    result.terminal.send('\t')
    await tick()
    result.terminal.send('\x03')

    listCandidates.mockRejectedValueOnce(new Error('candidate lookup failed'))
    result.terminal.send('@failed')
    await vi.waitFor(() => { expect(listCandidates).toHaveBeenCalled() })
    result.terminal.send('\x03')

    result.terminal.send('@empty')
    await tick()
    result.terminal.send('\x03')

    let releaseBase: (() => void) | undefined
    const baseSuggestions = vi.spyOn(CombinedAutocompleteProvider.prototype, 'getSuggestions')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseBase = resolve })
        return null
      })
    listCandidates.mockResolvedValueOnce([])
    result.terminal.send('@base-slow')
    await vi.waitFor(() => { expect(releaseBase).toBeTypeOf('function') })
    const baseWaitSignal = listCandidates.mock.calls.at(-1)?.[3]
    result.terminal.send('x')
    await vi.waitFor(() => { expect(baseWaitSignal?.aborted).toBe(true) })
    releaseBase?.()
    await tick()
    baseSuggestions.mockRestore()

    let delayedSignal: AbortSignal | undefined
    let delayed = true
    listCandidates.mockImplementation(async (...args) => {
      if (!delayed) return originalListCandidates(...args)
      delayed = false
      delayedSignal = args[3]
      if (delayedSignal === undefined) throw new Error('expected autocomplete cancellation signal')
      await new Promise<void>((_resolve, reject) => {
        delayedSignal?.addEventListener('abort', () => { reject(new Error('superseded')) }, { once: true })
      })
      return []
    })
    result.terminal.send('@slow')
    await vi.waitFor(() => { expect(delayedSignal).toBeDefined() })
    result.terminal.send('x')
    await vi.waitFor(() => { expect(delayedSignal?.aborted).toBe(true) })
    await dispose(result)
  })

  it('keeps failed mention input and renders durable reference contexts as compact cards', async () => {
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
      },
    })
    const missing = formatSessionReferenceMention({ sessionId: SessionId('missing'), label: 'Missing chat' })
    result.terminal.send(`keep ${missing}`)
    result.terminal.send('\r')
    await tick()
    expect(result.agent.sent).toHaveLength(0)
    expect(result.terminal.output).toContain('Session reference failed')
    expect(result.terminal.output).toContain('keep @[')

    result.session.append('user/message', {
      content: [
        { type: 'text', text: 'hidden baked snapshot payload' },
        { type: 'text', text: '\n\n## My request:\n' },
        { type: 'text', text: 'visible referenced question' },
      ],
      source: { kind: 'user' },
      envelope: {
        displayContent: [{ type: 'text', text: 'visible referenced question' }],
        prefixContexts: [{
          source: { kind: 'plugin', plugin: 'session-reference' },
          meta: {
            kind: 'session-reference',
            references: [{ sessionId: 'prefixed', label: 'Prefixed source' }],
          },
        }],
      },
    }, { surfaceOp: 'append' })
    await tick()
    expect(result.terminal.output).toContain('visible referenced question')
    expect(result.terminal.output).toContain('Referenced sessions · Prefixed source (prefixed)')
    expect(result.terminal.output).not.toContain('hidden baked snapshot payload')

    result.session.append('steering/message', {
      turn: 1,
      content: [
        { type: 'text', text: 'hidden non-reference prefix' },
        { type: 'text', text: '\n\n## My request:\n' },
        { type: 'text', text: 'visible steering prompt' },
      ],
      source: { kind: 'user' },
      envelope: {
        displayContent: [{ type: 'text', text: 'visible steering prompt' }],
        prefixContexts: [
          { source: { kind: 'plugin', plugin: 'other' }, meta: { kind: 'other' } },
          {
            source: { kind: 'plugin', plugin: 'session-reference' },
            meta: {
              kind: 'session-reference',
              references: [{ sessionId: 'steering-source', label: 'Steering source' }],
            },
          },
        ],
      },
    }, { surfaceOp: 'append' })
    await tick()
    expect(result.terminal.output).toContain('visible steering prompt')
    expect(result.terminal.output).toContain('Referenced sessions · Steering source (steering-source)')
    expect(result.terminal.output).not.toContain('hidden non-reference prefix')

    result.session.append('user/message', {
      content: [{ type: 'text', text: 'secret full snapshot payload' }],
      source: { kind: 'plugin', plugin: 'session-reference' },
      meta: {
        kind: 'session-reference',
        version: 1,
        references: [{ sessionId: 'source', label: 'Source', capturedThroughSeq: 2 }],
      },
    }, { surfaceOp: 'append' })
    await tick()
    expect(result.terminal.output).toContain('Referenced sessions · Source (source)')
    expect(result.terminal.output).not.toContain('secret full snapshot payload')

    const invalidCards: [JsonValue, string][] = [
      [{ kind: 'other' }, 'invalid-kind'],
      [{ kind: 'session-reference', references: [null] }, 'invalid-entry'],
      [{ kind: 'session-reference', references: [{}] }, 'invalid-fields'],
    ]
    for (const [meta, text] of invalidCards) {
      result.session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'session-reference' },
        meta,
      }, { surfaceOp: 'append' })
    }
    result.session.append('user/message', {
      content: [{ type: 'text', text: 'same-label snapshot' }],
      source: { kind: 'plugin', plugin: 'session-reference' },
      meta: { kind: 'session-reference', references: [{ sessionId: 'same', label: 'same' }] },
    }, { surfaceOp: 'append' })
    await tick()
    expect(result.terminal.output).toContain('Referenced sessions · same')
    await dispose(result)
  })

  it('reports malformed and unavailable references without enqueueing', async () => {
    const malformed = await setup()
    malformed.terminal.send('use dsh-session:IiJ')
    malformed.terminal.send('\r')
    await tick()
    expect(malformed.agent.sent).toHaveLength(0)
    expect(malformed.terminal.output).toContain('Invalid session reference')
    await dispose(malformed)

    const unavailable = await setup()
    const mention = formatSessionReferenceMention({ sessionId: SessionId('source') })
    unavailable.terminal.send(`use ${mention}`)
    unavailable.terminal.send('\r')
    await tick()
    expect(unavailable.agent.sent).toHaveLength(0)
    expect(unavailable.terminal.output).toContain('Session reference capability unavailable')
    await dispose(unavailable)
  })

  it('clears a retyped successful mention and aborts pending preparation on disposal', async () => {
    const result = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
        ctx.sessions.create(SessionId('source'))
      },
    })
    const mention = formatSessionReferenceMention({ sessionId: SessionId('source') })
    const value = `use ${mention}`
    let release: (() => void) | undefined
    const prepare = vi.spyOn(result.ctx.sessionReferences, 'prepare').mockImplementation(
      (_agent, content) => new Promise((resolve) => {
        release = () => { resolve({ content, contexts: [] }) }
      }),
    )
    result.terminal.send(value)
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(prepare).toHaveBeenCalledOnce() })
    result.terminal.send(value)
    release?.()
    await tick()
    expect(result.agent.sent).toEqual([[{ type: 'text', text: 'use @source' }]])

    let rejectPreparation: (() => void) | undefined
    prepare.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectPreparation = () => { reject(new Error('delayed failure')) }
    }))
    result.terminal.send(value)
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(rejectPreparation).toBeTypeOf('function') })
    result.terminal.send('new draft')
    rejectPreparation?.()
    await tick()
    expect(result.terminal.output).toContain('delayed failure')
    result.terminal.send('\x03')

    let pendingSignal: AbortSignal | undefined
    prepare.mockImplementation((_agent, _content, _references, signal) => new Promise((_resolve, reject) => {
      pendingSignal = signal
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    result.terminal.send(value)
    result.terminal.send('\r')
    await vi.waitFor(() => { expect(pendingSignal).toBeDefined() })
    await result.controller.dispose()
    expect(pendingSignal?.aborted).toBe(true)
    await tick()
    await result.ctx.fiber.dispose()

    const lateSuccess = await setup({
      async configureContext(ctx) {
        ctx.provide('tools', { get: () => undefined } as never)
        await ctx.plugin(TestSessionQueryService)
        await ctx.plugin(SessionReferenceService)
        ctx.sessions.create(SessionId('source'))
      },
    })
    let resolveAfterDispose: (() => void) | undefined
    const latePrepare = vi.spyOn(lateSuccess.ctx.sessionReferences, 'prepare').mockImplementation(
      (_agent, content) => new Promise((resolve) => {
        resolveAfterDispose = () => { resolve({ content, contexts: [] }) }
      }),
    )
    lateSuccess.terminal.send(value)
    lateSuccess.terminal.send('\r')
    await vi.waitFor(() => { expect(latePrepare).toHaveBeenCalledOnce() })
    await lateSuccess.controller.dispose()
    resolveAfterDispose?.()
    await tick()
    expect(lateSuccess.agent.sent).toHaveLength(0)
    await lateSuccess.ctx.fiber.dispose()
  })

  it('opens a keyboard selector and switches the session model without sending slash text to the agent', async () => {
    const initialContext = Promise.withResolvers<{ contextWindow: number }>()
    const result = await setup({
      agentOptions: { provider: 'alpha', model: 'a1' },
      contextTokens: 50,
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
        models: [
          { provider: 'alpha', id: 'a1', name: 'Alpha One', description: 'Fast' },
          { provider: 'alpha', id: 'shared', name: 'Alpha Shared' },
          { provider: 'beta', id: 'b1', name: 'Beta One' },
          { provider: 'beta', id: 'shared', name: 'Beta Shared' },
        ],
        resolveModelContext: (provider, model) => provider === 'alpha' && model === 'a1'
          ? initialContext.promise
          : Promise.resolve({ contextWindow: 200 }),
      },
    })

    for (const command of ['/model too many model arguments', '/model missing', '/model shared', '/model alpha/a1', '/model alpha a1']) {
      result.terminal.send(command)
      result.terminal.send('\r')
      await tick()
    }
    expect(result.terminal.output).toContain('Usage: /model')
    expect(result.terminal.output).toContain('Unknown model: missing')
    expect(result.terminal.output).toContain('advertised by multiple providers')
    expect(result.terminal.output).toContain('already alpha/a1')

    const firstSelectorOutput = result.terminal.output.length
    result.terminal.send('/model')
    result.terminal.send('\r')
    result.terminal.send('/model')
    result.terminal.send('\r')
    await vi.waitFor(() => {
      expect(result.terminal.output.slice(firstSelectorOutput)).toContain('Select model')
    })
    result.terminal.send('\x1b')
    await tick()

    result.agent.status = 'running'
    const runningSelectorOutput = result.terminal.output.length
    result.terminal.send('/model')
    result.terminal.send('\r')
    await vi.waitFor(() => {
      const output = result.terminal.output.slice(runningSelectorOutput)
      expect(output).toContain('Select model')
      expect(output).toContain('alpha/a1')
      expect(output).toContain('Alpha One — Fast — current')
    })
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[B')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Model selected: beta/b1')
    expect(result.agent.sent).toEqual([])
    expect(result.agent.steered).toEqual([])
    initialContext.resolve({ contextWindow: 100 })
    await tick()
    expect(result.terminal.output).not.toContain('50% context  tools:collapsed')

    const cancelledSelectorOutput = result.terminal.output.length
    result.terminal.send('/model')
    result.terminal.send('\r')
    await vi.waitFor(() => {
      expect(result.terminal.output.slice(cancelledSelectorOutput)).toContain('Select model')
    })
    result.terminal.send('\x1b')
    await tick()
    expect(result.agent.cancelled).not.toContain('cancelled from terminal')
    result.agent.status = 'idle'
    result.ctx.emit('agent/status', result.agent, 'idle')
    await tick()
    expect(result.terminal.output).toContain('b1  ')
    expect(result.terminal.output).toContain('25% context  tools:collapsed')

    const assembly = await result.ctx.systemPrompt.assemble(assembleContextFor(result.agent))
    expect(assembly.variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const seed: LlmCallConfig = { provider: 'alpha', model: 'a1', temperature: 0.2 }
    const request = await agentEvents(result.ctx, result.agent).waterfall(
      'agent/request', 1, 0, seed, new AbortController().signal, () => Promise.resolve(seed),
    )
    expect(request).toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })
    await dispose(result)
  })

  it('restores the logged model, keeps an unlisted current model visible, and reports catalog failures', async () => {
    const resumed = await setup({
      agentOptions: { provider: 'alpha', model: 'configured' },
      catalog: { providers: [{ id: 'beta', name: 'Beta' }], models: [] },
      beforeMount(session) {
        session.append('request/header', {
          header: { config: { provider: 'beta', model: 'private' } },
          reason: 'initial',
        })
      },
    })
    resumed.terminal.send('/model')
    resumed.terminal.send('\r')
    await tick()
    expect(resumed.terminal.output).toContain('Select model')
    expect(resumed.terminal.output).toContain('beta/private')
    expect(resumed.terminal.output).toContain('private — current')
    await dispose(resumed)

    const unset = await setup({
      agentOptions: {},
      catalog: {
        providers: [{ id: 'alpha', name: 'Alpha' }],
        models: [{ provider: 'alpha', id: 'a1', name: 'Alpha One' }],
        resolveModelContext: () => Promise.resolve(undefined),
      },
    })
    unset.terminal.send('/model')
    unset.terminal.send('\r')
    await tick()
    unset.terminal.send('\r')
    await tick()
    expect(unset.terminal.output).toContain('Model selected: alpha/a1')
    expect(unset.terminal.output).toContain('a1  ')
    expect(unset.terminal.output).not.toContain('% context')
    await dispose(unset)

    const empty = await setup({ agentOptions: {}, catalog: { providers: [], models: [] } })
    empty.terminal.send('/model')
    empty.terminal.send('\r')
    await tick()
    expect(empty.terminal.output).toContain('Current model: unset')
    expect(empty.terminal.output).toContain('No models are advertised')
    const assembly = await empty.ctx.systemPrompt.assemble(assembleContextFor(empty.agent))
    expect(assembly.variables).toEqual({})
    const seed: LlmCallConfig = { provider: 'fallback', model: 'fallback' }
    await expect(agentEvents(empty.ctx, empty.agent).waterfall(
      'agent/request', 1, 0, seed, new AbortController().signal, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await dispose(empty)

    const failed = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => Promise.reject(new Error('catalog offline')),
        resolveModelContext: () => Promise.reject(new Error('capacity offline')),
      },
    })
    failed.terminal.send('/model')
    failed.terminal.send('\r')
    await vi.waitFor(() => {
      expect(failed.terminal.output).toContain('Could not read the model catalog: catalog offline')
    })
    expect(failed.terminal.output).toContain('Could not resolve model context: capacity offline')
    await dispose(failed)
  })

  it('does not render a model catalog that resolves after TUI disposal', async () => {
    const deferred = Promise.withResolvers<never[]>()
    const result = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => deferred.promise,
      },
    })
    result.terminal.send('/model')
    result.terminal.send('\r')
    await result.controller.dispose()
    deferred.resolve([])
    await tick()
    expect(result.terminal.output).not.toContain('Available models')
    await result.ctx.fiber.dispose()

    const rejected = Promise.withResolvers<never[]>()
    const rejectedResult = await setup({
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        listModels: () => rejected.promise,
      },
    })
    rejectedResult.terminal.send('/model')
    rejectedResult.terminal.send('\r')
    await rejectedResult.controller.dispose()
    rejected.reject(new Error('late catalog failure'))
    await tick()
    expect(rejectedResult.terminal.output).not.toContain('late catalog failure')
    await rejectedResult.ctx.fiber.dispose()

    const context = Promise.withResolvers<{ contextWindow: number }>()
    const contextResult = await setup({
      contextTokens: 99,
      catalog: {
        providers: [{ id: 'deepseek', name: 'DeepSeek' }],
        models: [],
        resolveModelContext: () => context.promise,
      },
    })
    await contextResult.controller.dispose()
    context.resolve({ contextWindow: 100 })
    await tick()
    expect(contextResult.terminal.output).not.toContain('99% context')
    await contextResult.ctx.fiber.dispose()
  })

  it('discovers and executes plugin commands, then removes TUI-local commands on disposal', async () => {
    const result = await setup()
    const handler = vi.fn(({ rawInput }: CommandInvocation) => ({
      kind: 'success' as const,
      text: `PLUGIN:${rawInput}`,
    }))
    result.ctx.commands.register({
      name: 'plugin-check',
      description: 'Run a plugin command',
      input: { hint: '<value>' },
      handler,
    })
    result.ctx.commands.register({
      name: 'plugin-fail',
      description: 'Fail a plugin command',
      handler: () => { throw new Error('plugin command exploded') },
    })
    result.ctx.commands.register({
      name: 'plugin-error',
      description: 'Return an error result',
      handler: () => ({ kind: 'error' as const, text: 'plugin error result' }),
    })

    result.terminal.send('/plugin-ch')
    await tick()
    expect(result.terminal.output).toContain('<value> — Run a plugin command')
    result.terminal.send('\x03')

    result.terminal.send('/plugin-check  value  ')
    result.terminal.send('\r')
    await tick()

    expect(handler).toHaveBeenCalledTimes(1)
    const invocation = handler.mock.calls[0]?.[0]
    expect(invocation?.agent).toBe(result.agent)
    // pi-tui's Editor owns terminal-line normalization and removes trailing
    // spaces before onSubmit; the registry preserves the adapter-delivered line.
    expect(invocation?.rawInput).toBe('  value')
    expect(result.terminal.output).toContain('PLUGIN:  value')
    result.terminal.send('/plugin-fail')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Command failed: plugin command exploded')
    result.terminal.send('/plugin-error')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('plugin error result')
    result.terminal.send('/help')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('/plugin-check <value> — Run a plugin command')
    expect(result.ctx.commands.list(result.agent).map(command => command.name)).toContain('help')

    await result.controller.dispose()
    expect(result.ctx.commands.list(result.agent).map(command => command.name)).toEqual([
      'plugin-check',
      'plugin-error',
      'plugin-fail',
    ])
    await result.ctx.fiber.dispose()
  })

  it('aborts an in-flight plugin command during TUI disposal', async () => {
    const result = await setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let commandSignal: AbortSignal | undefined
    result.ctx.commands.register({
      name: 'wait-plugin',
      description: 'Wait until disposal',
      handler: ({ signal }) => {
        commandSignal = signal
        started()
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ kind: 'error', text: 'late result' }) }, { once: true })
        })
      },
    })

    result.terminal.send('/wait-plugin')
    result.terminal.send('\r')
    await ready
    await result.controller.dispose()

    expect(commandSignal?.aborted).toBe(true)
    expect(result.terminal.output).not.toContain('late result')
    await result.ctx.fiber.dispose()
  })

  it('suppresses a successful plugin result that settles as TUI disposal starts', async () => {
    const result = await setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let resolveCommand!: (result: { kind: 'success'; text: string }) => void
    result.ctx.commands.register({
      name: 'late-success',
      description: 'Resolve while the TUI closes',
      handler: () => new Promise((resolve) => {
        resolveCommand = resolve
        started()
      }),
    })

    result.terminal.send('/late-success')
    result.terminal.send('\r')
    await ready
    resolveCommand({ kind: 'success', text: 'must not render after disposal' })
    // Let the command boundary accept the result before disposal, but leave the
    // TUI continuation queued so the success-side disposal guard owns the race.
    await Promise.resolve()
    await result.controller.dispose()
    await tick()

    expect(result.terminal.output).not.toContain('must not render after disposal')
    await result.ctx.fiber.dispose()
  })

  it('cancels before /exit while running and handles agent errors/disposal', async () => {
    const result = await setup({ status: 'running' })
    result.terminal.send('/exit')
    result.terminal.send('\r')
    await tick()
    expect(result.agent.cancelled).toContainEqual({ kind: 'user' })
    expect(result.exit).toHaveBeenCalledWith(0)

    const events = await setup()
    const unrelatedSession = events.ctx.sessions.create(SessionId('unrelated-session'))
    const unrelatedAgent = { ...events.agent, id: unrelatedSession.id, session: unrelatedSession } as unknown as Agent
    unrelatedSession.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    unrelatedSession.append('todo/write', { todos: [{ content: 'hidden', status: 'pending' }] })
    agentEvents(events.ctx, unrelatedAgent).emit('agent/status', 'running')
    agentEvents(events.ctx, unrelatedAgent).emit('agent/error', 1, 1, new Error('hidden error'))
    agentEvents(events.ctx, unrelatedAgent).emit('agent/disposed')
    agentEvents(events.ctx, events.agent).emit('agent/error', 1, 1, new Error('live failure'))
    events.session.append('step/end', { turn: 1, step: 1 })
    events.session.append('turn/end', { turn: 1, reason: { kind: 'error', step: 1, message: 'live failure' } })
    events.session.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 2, reason: { kind: 'error', step: 1, message: 'durable failure' } })
    events.session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 3, reason: { kind: 'aborted' } })
    events.session.append('turn/start', { turn: 4, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 4, reason: { kind: 'max-tokens' } })
    events.session.append('turn/start', { turn: 5, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 5, reason: { kind: 'rejected', reason: 'policy' } })
    events.session.append('turn/start', { turn: 6, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', { turn: 6, reason: { kind: 'interrupted' } })
    events.session.append('turn/start', { turn: 7, trigger: { kind: 'message', source: { kind: 'user' } } })
    events.session.append('turn/end', {
      turn: 7,
      reason: { kind: 'error', step: 1, failure: { message: 'structured provider failure', code: 'SERVER' } },
    })
    agentEvents(events.ctx, events.agent).emit('agent/disposed')
    await tick()
    expect(events.terminal.output).toContain('live failure')
    expect(events.terminal.output).toContain('durable failure')
    expect(events.terminal.output).toContain('Turn cancelled')
    expect(events.terminal.output).toContain('structured provider failure')
    expect(events.terminal.output).toContain('output-token limit')
    expect(events.terminal.output).toContain('Turn rejected')
    expect(events.terminal.output).toContain('previous process ended')
    expect(events.terminal.output).toContain('was disposed')
    await dispose(events)
  })
})

describe('skill slash command', () => {
  const withSkills = async (ctx: Context): Promise<void> => {
    ctx.provide('tools', { get() { return undefined } } as never)
    await ctx.plugin(SkillService)
    const skills = ctx.get('skills')
    if (skills === undefined) throw new Error('skills service not mounted')
    skills.register({ name: 'demo-skill', description: 'Demo skill for tests', source: 'runtime', provider: 'runtime', content: 'Demo instructions body.' })
    skills.register({ name: 'hidden-skill', description: 'Model-hidden skill', source: 'runtime', provider: 'runtime', content: 'Hidden instructions body.', disableModelInvocation: true })
  }

  it('offers non-hidden skills as slash completions and hides model-disabled ones', async () => {
    const result = await setup({ configureContext: withSkills })
    result.terminal.send('/skill')
    await tick()
    expect(result.terminal.output).toContain('demo-skill')
    expect(result.terminal.output).not.toContain('hidden-skill')
    await dispose(result)
  })

  it('loads a skill as a user turn, appending typed instructions', async () => {
    const result = await setup({ configureContext: withSkills })
    result.terminal.send('/skill:demo-skill')
    result.terminal.send('\r')
    await tick()
    expect(result.agent.sent).toEqual([[{ type: 'text', text: '<skill name="demo-skill">\nDemo instructions body.\n</skill>' }]])

    result.agent.status = 'running'
    result.terminal.send('/skill:demo-skill focus on tests')
    result.terminal.send('\r')
    await tick()
    expect(result.agent.steered).toEqual([[{ type: 'text', text: '<skill name="demo-skill">\nDemo instructions body.\n</skill>\n\nfocus on tests' }]])
    await dispose(result)
  })

  it('invokes a model-disabled skill by its exact name', async () => {
    const result = await setup({ configureContext: withSkills })
    result.terminal.send('/skill:hidden-skill')
    result.terminal.send('\r')
    await tick()
    expect(result.agent.sent).toEqual([[{ type: 'text', text: '<skill name="hidden-skill">\nHidden instructions body.\n</skill>' }]])
    await dispose(result)
  })

  it('reports an unknown skill and an empty skill name without sending', async () => {
    const result = await setup({ configureContext: withSkills })
    result.terminal.send('/skill:does-not-exist')
    result.terminal.send('\r')
    await tick()
    result.terminal.send('/skill:')
    result.terminal.send('\r')
    await tick()
    // A space right after the colon parses to an empty name, not a name of
    // "focus"; the documented syntax puts the name immediately after the colon.
    result.terminal.send('/skill: focus')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Unknown skill: does-not-exist')
    expect(result.terminal.output).toContain('Usage: /skill:<name>')
    expect(result.agent.sent).toEqual([])
    await dispose(result)
  })

  it('warns when no skill service is mounted', async () => {
    const result = await setup()
    result.terminal.send('/skill:demo-skill')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Skills are not available')
    expect(result.agent.sent).toEqual([])
    await dispose(result)
  })

  it('surfaces skill lookup failures as an error notice', async () => {
    const result = await setup({
      configureContext: async (ctx) => {
        ctx.provide('tools', { get() { return undefined } } as never)
        ctx.provide('skills', {
          list: () => Promise.reject(new Error('list boom')),
          get: () => Promise.reject(new Error('get boom')),
        } as never)
      },
    })
    result.terminal.send('/skill:demo-skill')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('failed to load')
    expect(result.terminal.output).toContain('get boom')
    await dispose(result)
  })

  it('drops skill list and lookup results that settle after disposal', async () => {
    const pendingList: Array<(value: SkillSummary[]) => void> = []
    const pendingGet: Array<{ resolve: (value: SkillDefinition | undefined) => void; reject: (error: unknown) => void }> = []
    const result = await setup({
      configureContext: async (ctx) => {
        ctx.provide('tools', { get() { return undefined } } as never)
        ctx.provide('skills', {
          list: () => new Promise<SkillSummary[]>((resolve) => { pendingList.push(resolve) }),
          get: () => new Promise<SkillDefinition | undefined>((resolve, reject) => { pendingGet.push({ resolve, reject }) }),
        } as never)
      },
    })
    result.terminal.send('/skill:demo-skill')
    result.terminal.send('\r')
    await tick()
    result.terminal.send('/skill:other-skill')
    result.terminal.send('\r')
    await tick()
    await dispose(result)

    for (const resolve of pendingList) resolve([{ name: 'late', description: 'late', source: 'runtime', provider: 'runtime' }])
    pendingGet[0]?.resolve({ name: 'demo-skill', description: 'late', source: 'runtime', provider: 'runtime', content: 'late body' })
    pendingGet[1]?.reject(new Error('late failure'))
    await tick()
    expect(result.agent.sent).toEqual([])
    expect(result.terminal.output).not.toContain('late failure')
    expect(result.terminal.output).not.toContain('late body')
  })
})

describe('renderSkillInvocation', () => {
  const skill: SkillDefinition = {
    name: 'demo-skill',
    description: 'Demo skill',
    source: 'runtime',
    provider: 'runtime',
    content: 'Body text.',
  }

  it('renders directory, url, opaque, and absent resource bases', () => {
    expect(renderSkillInvocation({ ...skill, resourceBase: { kind: 'directory', path: '/skills/demo' } }, '')).toBe(
      '<skill name="demo-skill">\nReferences in this skill are relative to /skills/demo.\n\nBody text.\n</skill>',
    )
    expect(renderSkillInvocation({ ...skill, resourceBase: { kind: 'url', url: 'https://x/y' } }, 'go')).toBe(
      '<skill name="demo-skill">\nReferences in this skill are relative to https://x/y.\n\nBody text.\n</skill>\n\ngo',
    )
    expect(renderSkillInvocation({ ...skill, resourceBase: { kind: 'opaque', description: 'held in memory' } }, '')).toBe(
      '<skill name="demo-skill">\nheld in memory\n\nBody text.\n</skill>',
    )
    expect(renderSkillInvocation(skill, '')).toBe('<skill name="demo-skill">\nBody text.\n</skill>')
  })

  it('throws on an unknown resource base kind', () => {
    expect(() => renderSkillInvocation({ ...skill, resourceBase: { kind: 'future' } as never }, '')).toThrow('unreachable variant')
  })
})

describe('tool cards and surface replay', () => {
  const tools: Record<string, ToolDefinition> = {
    bash: {
      name: 'bash', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'printf hello', description: 'Run command', cwd: '/tmp' }),
      presentResult: () => ({ card: 'terminal', output: 'hello\nworld\nthird', exitCode: 0 }),
    },
    signal: {
      name: 'signal', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'sleep 10' }),
      presentResult: () => ({ card: 'terminal', signal: 'SIGTERM' }),
    },
    edit: {
      name: 'edit', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({
        card: 'diff',
        title: 'Edit files',
        diffs: [
          { path: 'a.txt', oldText: 'old', newText: 'new' },
          { path: 'b.txt', oldText: 'before', newText: 'after' },
        ],
      }),
      presentResult: () => ({ card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'created' }] }),
    },
    generic: {
      name: 'generic', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Inspect value', rawInput: { alpha: 1 } }),
      presentResult: () => ({ card: 'generic', title: 'Inspected', content: [{ type: 'text', text: 'result text' }] }),
    },
    throwing: {
      name: 'throwing', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => { throw new Error('call presenter boom') },
      presentResult: () => { throw new Error('result presenter boom') },
    },
    rawTerminal: {
      name: 'rawTerminal', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'terminal', title: 'raw command' }),
    },
    undefinedViews: {
      name: 'undefinedViews', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => undefined,
      presentResult: () => undefined,
    },
    empty: {
      name: 'empty', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Empty card' }),
    },
    terminalResult: {
      name: 'terminalResult', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Becomes terminal' }),
      presentResult: () => ({ card: 'terminal', output: 'converted terminal' }),
    },
    symbolic: {
      name: 'symbolic', description: '', parameters: {}, output: UNUSED_TOOL_OUTPUT, execute: async () => [],
      presentCall: () => ({ card: 'generic', title: 'Symbol input', rawInput: Symbol('input') }),
    },
  }

  it('uses terminal, diff, generic, fallback, and collapsed tool presentations', async () => {
    const result = await setup({ tools, config: { maxToolOutputLines: 4 } })
    const calls = [
      ['c1', 'bash', '{"command":"printf hello"}'],
      ['c2', 'signal', '{}'],
      ['c3', 'edit', '{}'],
      ['c4', 'generic', '{}'],
      ['c5', 'throwing', '{}'],
      ['c6', 'unknown', 'not-json'],
      ['c7', 'rawTerminal', '{"value":"raw"}'],
      ['c8', 'undefinedViews', '{"value":8}'],
      ['c10', 'empty', '{}'],
      ['c11', 'terminalResult', '{}'],
      ['c12', 'symbolic', '{}'],
    ] as const
    appendAssistant(result.session, [
      { type: 'text', text: 'Calling tools' },
      ...calls.map(([id, name, args]) => ({
        type: 'tool-call' as const, id: id as never, name, arguments: args,
      })),
    ])
    for (const [id, name, args] of calls) {
      result.session.append('tool/call', { turn: 1, step: 1, callId: id as never, name, arguments: args })
    }
    await tick()
    expect(result.terminal.output).toContain('$ raw command')
    result.terminal.send('/reasoning')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('call presenter boom')
    expect(result.terminal.output).toContain('Symbol(input)')
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c1' as never, content: [{ type: 'text', text: 'raw bash' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c2' as never, content: [{ type: 'text', text: 'stopped' }], isError: true,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c3' as never, content: [{ type: 'text', text: 'done' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c4' as never, content: [{ type: 'text', text: 'raw generic' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c5' as never, content: [{ type: 'text', text: 'raw throwing' }], isError: false,
      meta: { value: 1 },
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c7' as never,
      content: [
        { type: 'tool-call', id: 'inner' as never, name: 'inner', arguments: '{}' },
        { type: 'tool-result', toolCallId: 'inner' as never, content: [{ type: 'text', text: 'nested output' }] },
        { type: 'future-result' } as never,
      ],
      isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c8' as never, content: [{ type: 'text', text: '\nundefined presenter output\n\nkept tail\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'c11' as never, content: [{ type: 'text', text: '\nconverted terminal\n\nfinished\n' }], isError: false,
    }, { surfaceOp: 'append' })
    result.session.append('tool/result', {
      turn: 1,
      step: 1,
      callId: 'orphan' as never,
      content: [{ type: 'text', text: 'orphan result' }],
      isError: true,
      error: { name: 'InterruptedError', code: 'interrupted' },
    }, { surfaceOp: 'append' })
    await tick()

    const output = result.terminal.output
    expect(output).toContain('Run command')
    expect(output).toContain('printf hello')
    expect(output).toContain('lines (Ctrl+O to expand)')
    expect(output).toContain('SIGTERM')
    expect(output).toContain('Edit files')
    expect(output).toContain('Inspected')
    expect(output).toContain('result text')
    expect(output).toContain('Presenter failed')
    expect(output).toContain('not-json')
    expect(output).toContain('nested output')
    expect(output).toContain('[future-result]')
    expect(output).toContain('undefined presenter output')
    expect(output).toContain('Empty card')
    expect(output).toContain('converted terminal')
    expect(output).toContain('orphan result')

    result.terminal.send('/redraw')
    result.terminal.send('\r')
    await tick()
    const collapsed = result.terminal.output.slice(result.terminal.output.lastIndexOf('\x1b[2J'))
    expect(collapsed).toContain('Run command')
    expect(collapsed).toContain('[exit 0]')
    expect(collapsed).not.toContain('▌ hello')
    expect(collapsed).not.toContain('world')
    result.terminal.send('\x0f')
    await tick()
    expect(result.terminal.output).toContain('world')
    expect(result.terminal.output).toContain('+ created')
    await dispose(result)
  })

  it('rebuilds after a surface replacement and hides shadowed tool calls', async () => {
    const result = await setup({ tools })
    appendUser(result.session, 'old prompt')
    const assistant = result.session.append('assistant/message', {
      turn: 1,
      step: 1,
      provenance: { provider: 'mock', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: 'old-call' as never, name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    result.session.append('tool/call', {
      turn: 1, step: 1, callId: 'old-call' as never, name: 'bash', arguments: '{}',
    })
    const toolResult = result.session.append('tool/result', {
      turn: 1, step: 1, callId: 'old-call' as never, content: [{ type: 'text', text: 'old output' }], isError: false,
    }, { surfaceOp: 'append' })
    const start = result.session.surface.nodes[0] as number
    result.session.append('user/message', {
      content: [{ type: 'text', text: 'summary replacement' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }, {
      surfaceOp: { op: 'replace', start, end: toolResult.seq },
      sourceEventSeqs: [start, assistant.seq, toolResult.seq],
    })
    await tick()

    result.terminal.resize(89)
    await tick()
    const lastFullRender = result.terminal.output.slice(result.terminal.output.lastIndexOf('\x1b[2J'))
    expect(lastFullRender).toContain('summary replacement')
    expect(lastFullRender).not.toContain('old output')
    await dispose(result)
  })
})

describe('TUI user-interaction dialogs', () => {
  it('answers single-select, multi-select, custom, and optionless questions', async () => {
    const result = await setup({ config: { maxQuestionOptions: 1 } })

    const single = result.ctx.userInteraction.ask({
      questions: [{
        id: 'mode', header: 'Mode', question: 'Choose a mode', detail: 'This choice controls the next turn.',
        options: [{ label: 'Safe', description: 'Use checks' }, { label: 'Fast' }],
      }],
    })
    await tick()
    expect(result.terminal.output).toContain('Choose a mode')
    expect(result.terminal.output).toContain('This choice controls the next turn.')
    expect(result.terminal.output).toContain('Question 1/1 (1 unanswered) · Mode')
    expect(result.terminal.output).toContain('1/2')
    result.terminal.send('\x1b[B')
    result.terminal.send('\r')
    await expect(single).resolves.toEqual({ answers: [{ id: 'mode', selected: ['Fast'] }] })

    const multi = result.ctx.userInteraction.ask({
      questions: [{ id: 'targets', question: 'Pick targets', multiSelect: true, options: [{ label: 'Code' }, { label: 'Docs' }] }],
    })
    await tick()
    result.terminal.send(' ')
    result.terminal.send('\x1b[B')
    result.terminal.send(' ')
    result.terminal.send('\r')
    await expect(multi).resolves.toEqual({ answers: [{ id: 'targets', selected: ['Code', 'Docs'] }] })

    const custom = result.ctx.userInteraction.ask({
      questions: [{ id: 'other', question: 'Choose or type', options: [{ label: 'Default' }] }],
    })
    await tick()
    result.terminal.send('\t')
    result.terminal.send('my choice')
    result.terminal.send('\r')
    await expect(custom).resolves.toEqual({ answers: [{ id: 'other', selected: [], custom: 'my choice' }] })

    const free = result.ctx.userInteraction.ask({ questions: [{ id: 'note', question: 'Add a note' }] })
    await tick()
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Enter an answer before submitting')
    result.terminal.send('ship it')
    result.terminal.send('\r')
    await expect(free).resolves.toEqual({ answers: [{ id: 'note', selected: [], custom: 'ship it' }] })
    await dispose(result)
  })

  it('handles option wrapping, deselection errors, and returning from custom input', async () => {
    const result = await setup({ config: { color: true } })
    const single = result.ctx.userInteraction.ask({
      questions: [{ id: 'single', question: 'Single options', options: [{ label: 'One' }, { label: 'Two' }] }],
    })
    const singleRejected = expect(single).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    expect(result.terminal.output).toContain('Two')
    result.terminal.send('\x03')
    await singleRejected

    const answer = result.ctx.userInteraction.ask({
      questions: [{
        id: 'options',
        question: 'Exercise options',
        multiSelect: true,
        options: [{ label: 'One', description: 'first' }, { label: 'Two' }],
      }],
    })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    result.terminal.send('\x1b[A')
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[B')
    result.terminal.send('\x1b[A')
    result.terminal.send(' ')
    await tick()
    result.terminal.send('x')
    result.terminal.send(' ')
    result.terminal.send('\r')
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('Select at least one option')
    })
    result.terminal.send('c')
    await tick()
    result.terminal.send('\x1b')
    await tick()
    expect(result.terminal.output).toContain('Space toggle')
    result.terminal.send('\x03')
    await rejected
    await dispose(result)
  })

  it('asks batches in order and rejects cancelled or aborted work', async () => {
    const result = await setup()
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(result.ctx.userInteraction.ask({
      questions: [{ id: 'pre-aborted', question: 'Already cancelled?' }],
      signal: preAborted.signal,
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })

    const batch = result.ctx.userInteraction.ask({
      questions: [
        { id: 'first', question: 'First?', options: [{ label: 'Yes' }] },
        { id: 'second', question: 'Second?' },
      ],
    })
    await tick()
    expect(result.terminal.output).toContain('Question 1/2 (2 unanswered)')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Second?')
    expect(result.terminal.output).toContain('Question 2/2 (1 unanswered)')
    result.terminal.send('done')
    result.terminal.send('\r')
    await expect(batch).resolves.toEqual({ answers: [
      { id: 'first', selected: ['Yes'] },
      { id: 'second', selected: [], custom: 'done' },
    ] })

    const cancelled = result.ctx.userInteraction.ask({ questions: [{ id: 'cancel', question: 'Cancel?' }] })
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    result.terminal.send('\x1b')
    await cancelledExpectation

    const controller = new AbortController()
    const active = result.ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }], signal: controller.signal })
    const queuedController = new AbortController()
    const queued = result.ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }], signal: queuedController.signal })
    const activeExpectation = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedExpectation = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    queuedController.abort()
    controller.abort()
    await activeExpectation
    await queuedExpectation
    await dispose(result)
  })

  it('rejects active and queued dialogs on disposal', async () => {
    const result = await setup()
    const active = result.ctx.userInteraction.ask({ questions: [{ id: 'active', question: 'Active?' }] })
    const queued = result.ctx.userInteraction.ask({ questions: [{ id: 'queued', question: 'Queued?' }] })
    const activeExpectation = expect(active).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const queuedExpectation = expect(queued).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await tick()
    await result.controller.dispose()
    await activeExpectation
    await queuedExpectation
    await expect(result.ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Late?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await result.ctx.fiber.dispose()
  })

  it('rejects malformed questions when a dialog cannot be constructed', async () => {
    const result = await setup()
    const broken = {
      id: 'broken',
      question: 'Broken question',
      get options(): never {
        throw new Error('question setup failed')
      },
    }
    const answer = result.ctx.userInteraction.ask({ questions: [broken] })
    await expect(answer).rejects.toThrow('ask_user_question TUI failed: question setup failed')
    await tick()
    expect(result.terminal.output).toContain('TUI overlay failed: question setup failed')
    await dispose(result)
  })
})

describe('TUI extension service', () => {
  it('renders effect-owned plugin overlays in the shared FIFO and restores editor input', async () => {
    const result = await setup()
    const sessions: TuiOverlaySession[] = []
    const hosts: TuiOverlayHost[] = []
    const plugin = result.ctx.inject(['tui'], (pluginCtx) => {
      expect(pluginCtx.tui.agent).toBe(result.agent)
      for (const label of ['first', 'second']) {
        sessions.push(pluginCtx.tui.openOverlay({
          create(host) {
            hosts.push(host)
            return {
              focused: false,
              render: width => [
                host.theme.accent(`${label} plugin overlay`),
                [
                  host.theme.text('text'),
                  host.theme.muted('muted'),
                  host.theme.dim('dim'),
                  host.theme.success('success'),
                  host.theme.warning('warning'),
                  host.theme.error('error'),
                  host.theme.bold('bold'),
                ].join(' '),
                `${String(host.viewport.columns)}x${String(host.viewport.rows)} · ${String(width)}`,
              ],
              handleInput(data) {
                host.invalidate()
                if (data === label[0]) host.close()
              },
              invalidate() {},
            }
          },
          options: { width: 50, maxHeight: 8, anchor: 'center', margin: 1 },
        }))
      }
    })
    await plugin
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('first plugin overlay')
    })
    expect(sessions.map(session => session.state)).toEqual(['active', 'queued'])
    expect(hosts).toHaveLength(1)

    const question = result.ctx.userInteraction.ask({
      questions: [{ id: 'after-plugin', question: 'Question after plugins?', options: [{ label: 'Yes' }] }],
    })
    result.terminal.send('f')
    await expect(sessions[0]!.closed).resolves.toEqual({ reason: 'closed' })
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('second plugin overlay')
    })
    expect(hosts).toHaveLength(2)
    expect(sessions[1]?.state).toBe('active')

    result.terminal.send('s')
    await expect(sessions[1]!.closed).resolves.toEqual({ reason: 'closed' })
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('Question after plugins?')
    })
    result.terminal.send('\r')
    await expect(question).resolves.toEqual({
      answers: [{ id: 'after-plugin', selected: ['Yes'] }],
    })

    result.terminal.send('editor works again')
    result.terminal.send('\r')
    expect(result.agent.sent.at(-1)).toEqual([{ type: 'text', text: 'editor works again' }])
    await plugin.dispose()
    await dispose(result)
  })

  it('unloads and reloads dependent plugins with the mounted TUI', async () => {
    const result = await setup()
    const sessions: TuiOverlaySession[] = []
    const signals: AbortSignal[] = []
    let starts = 0
    const plugin = result.ctx.inject(['tui'], (pluginCtx) => {
      starts += 1
      sessions.push(pluginCtx.tui.openOverlay({
        create(host) {
          signals.push(host.signal)
          return {
            render: () => [`plugin mount ${String(starts)}`],
            invalidate() {},
          }
        },
      }))
    })
    await plugin
    await vi.waitFor(() => {
      expect(result.terminal.output).toContain('plugin mount 1')
    })

    await result.controller.dispose()
    await expect(sessions[0]!.closed).resolves.toEqual({ reason: 'owner-disposed' })
    expect(signals[0]?.aborted).toBe(true)
    expect(result.ctx.get('tui')).toBeUndefined()

    const secondTerminal = new FakeTerminal()
    const secondController = createTuiChat(result.ctx, {
      sessionId: result.agent.id,
      color: false,
      welcome: 'Mounted again.',
    }, {
      terminal: secondTerminal,
      exit: vi.fn(),
    })
    await vi.waitFor(() => {
      expect(starts).toBe(2)
      expect(secondTerminal.output).toContain('plugin mount 2')
    })
    await sessions[1]?.close()
    await secondController.dispose()
    await plugin.dispose()
    await result.ctx.fiber.dispose()
  })
})

describe('terminal mounting', () => {
  it('starts immediately when the configured agent already exists', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('main'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'idle', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    mountTui(ctx, { color: false }, { terminal, exit: vi.fn() })
    await tick()
    expect(terminal.started).toBe(1)
    await ctx.fiber.dispose()
  })

  it('degrades /reload to a warning when mounted as a real plugin without a Loader', async () => {
    // Production shape: the TUI runs inside a plugin fiber, where a bare
    // `ctx.loader` proxy read would THROW `cannot get property without
    // inject` — only the non-throwing `ctx.get` lookup degrades gracefully.
    const ctx = new Context()
    provideTokenMeter(ctx)
    provideLlmCatalog(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('main'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'idle', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    // Mirror dsh-tui's own inject (minus loader, the absence under test).
    await ctx.plugin({
      inject: ['agents', 'commands', 'userInteraction', 'tools', 'llm', 'tokenMeter'],
      apply: (pluginCtx: Context) => {
        mountTui(pluginCtx, { color: false }, { terminal, exit: vi.fn() })
      },
    })
    await tick()
    expect(terminal.started).toBe(1)
    terminal.send('/reload')
    terminal.send('\r')
    await tick()
    expect(terminal.output).toContain('/reload needs the cordis Loader')
    await ctx.fiber.dispose()
  })

  it('waits for its configured agent before starting the TUI', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    mountTui(ctx, { sessionId: 'late-session', color: false }, { terminal, exit: vi.fn() })
    expect(terminal.started).toBe(0)

    const otherSession = ctx.sessions.create(SessionId('other-session'))
    ctx.agents.register({
      id: otherSession.id, options: {}, session: otherSession, status: 'idle', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    })
    expect(terminal.started).toBe(0)

    const session = ctx.sessions.create(SessionId('late-session'))
    const agent = {
      id: session.id, options: {}, session, status: 'idle', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    } as Agent
    ctx.agents.register(agent)
    await tick()
    expect(terminal.started).toBe(1)
    await ctx.fiber.dispose()
  })

  it('prints a matching live startup failure and exits instead of waiting forever', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    const exit = vi.fn()
    mountTui(ctx, { sessionId: 'main-session', color: false }, { terminal, exit })

    ctx.emit('agent-loop/config-start-failed', SessionId('other-session'), new Error('other failed'))
    expect(terminal.output).toBe('')
    expect(exit).not.toHaveBeenCalled()
    ctx.emit('agent-loop/config-start-failed', SessionId('main-session'), new Error('resume \u001b]2;failure-controlled\u0007'))
    expect(terminal.output).toBe('ui-tui: session "main-session" failed to start: resume \\x1b]2;failure-controlled\\x07\n')
    expect(exit).toHaveBeenCalledWith(1)

    const session = ctx.sessions.create(SessionId('main-session'))
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'idle', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    })
    await tick()
    expect(terminal.started).toBe(0)
    await ctx.fiber.dispose()
  })

  it('renders an uncoercible startup failure without escaping the display boundary', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const terminal = new FakeTerminal()
    const exit = vi.fn()

    mountTui(ctx, { sessionId: 'main-session', color: false }, { terminal, exit })
    ctx.emit('agent-loop/config-start-failed', SessionId('main-session'), {
      toString(): string { throw new Error('coercion failed') },
    })

    expect(terminal.started).toBe(0)
    expect(terminal.output).toBe('ui-tui: session "main-session" failed to start: <unrenderable value>\n')
    expect(exit).toHaveBeenCalledWith(1)
    await ctx.fiber.dispose()
  })

  it('rolls back providers, listeners, and terminal state when startup fails', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('failed-start-session'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn: 1, step: 1 })
    ctx.agents.register({
      id: session.id, options: {}, session, status: 'running', ctx,
      followup: () => AgentMessageId('stub'), queue: () => AgentMessageId('stub'), steer: () => AgentMessageId('stub'), inject: () => AgentMessageId('stub'), send: () => AgentMessageId('stub'), cancel() {}, whenIdle: () => Promise.resolve(),
    })
    const terminal = new FakeTerminal()
    terminal.start = () => { throw new Error('terminal startup failed') }

    expect(() => createTuiChat(ctx, { sessionId: 'failed-start-session', color: false }, { terminal, exit: vi.fn() }))
      .toThrow('terminal startup failed')
    await tick()
    expect(ctx.commands.list(ctx.agents.get(SessionId('failed-start-session'))!)).toEqual([])
    expect(terminal.stopped).toBe(1)
    expect(terminal.progress).toEqual([false, true, false])
    expect(ctx.get('tui')).toBeUndefined()
    await expect(ctx.userInteraction.ask({ questions: [{ id: 'late', question: 'Late?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'must not render' },
    })
    await tick()
    expect(terminal.output).not.toContain('must not render')
    await ctx.fiber.dispose()
  })

  it('throws when createTuiChat is called without the configured agent', async () => {
    const ctx = new Context()
    provideTokenMeter(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CommandService)
    await ctx.plugin(UserInteractionService)
    ctx.provide('tools', { get: () => undefined } as never)
    const runtime: TuiRuntime = { terminal: new FakeTerminal(), exit: vi.fn() }
    expect(() => createTuiChat(ctx, { sessionId: 'missing' }, runtime)).toThrow('is not running')
    await ctx.fiber.dispose()
  })

  it('detects a light terminal color scheme and switches from dark- to light-optimised ANSI codes', async () => {
    const result = await setup({ config: { color: true } })
    // Initial render uses dark-optimised palette: SGR 2 (dim) for dim text.
    expect(result.terminal.output).toContain('\x1b[2mdeepseek-v4-flash')

    // A report matching the current scheme is a no-op: no palette rebuild or
    // re-render (ESC [?997;1n = dark, the startup default).
    const beforeSameScheme = result.terminal.output.length
    result.terminal.send('\x1b[?997;1n')
    await tick()
    expect(result.terminal.output.length).toBe(beforeSameScheme)

    // Simulate the terminal responding with a light color scheme report
    // (ESC [?997;2n = light, ESC [?997;1n = dark).
    result.terminal.send('\x1b[?997;2n')
    await tick()
    await tick()

    // After switching to light-optimised palette: palette.dim uses ANSI 90
    // (gray) instead of SGR 2. The header now uses \x1b[90m for the detail
    // line. The cumulative output still contains the initial SGR 2 render,
    // so we assert that a LATER write (appended after the scheme switch)
    // uses ANSI 90 for the same header text.
    expect(result.terminal.output).toContain('\x1b[90mdeepseek-v4-flash')

    // Switch back to dark scheme.
    result.terminal.send('\x1b[?997;1n')
    await tick()
    await tick()
    // After switching back, a new write uses SGR 2 for the header detail.
    expect(result.terminal.output).toContain('\x1b[2mdeepseek-v4-flash')
    await dispose(result)
  })

  it('keeps the dark palette when the terminal rejects the color-scheme query', async () => {
    class QueryFailTerminal extends FakeTerminal {
      override write(data: string): void {
        // The device-status query is the only write that fails; the promise
        // rejects and the swallowed `.catch` leaves the dark palette in place.
        if (data === '\x1b[?996n') throw new Error('query write failed')
        super.write(data)
      }
    }
    const terminal = new QueryFailTerminal()
    const result = await createTuiTestHarness(terminal, vi.fn(), {
      config: { color: true },
      cwd: process.cwd(),
    })
    await tick()
    expect(terminal.output).toContain('\x1b[2mdeepseek-v4-flash')
    await disposeTuiTestHarness(result)
  })
  it('runs /reload against every file-backed loader subtree, reports completion, and rejects re-entry while in flight', async () => {
    const refreshed: string[] = []
    let releaseRefresh!: () => void
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const result = await setup({
      configureContext: async (ctx) => {
        ctx.provide('tools', { get: () => undefined } as never)
        // A structural Loader: two file-backed subtrees and one plain entry.
        // The first subtree blocks on a gate so re-entry can be probed
        // deterministically mid-flight.
        ctx.provide('loader', {
          entries: () => [
            { subtree: { refresh: async () => { refreshed.push('root'); await gate } } },
            {},
            { subtree: { refresh: async () => { refreshed.push('nested') } } },
          ],
        } as never)
      },
    })
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Reloading 2 config tree(s)')
    // Second /reload while the first is gated: refused, no extra refreshes.
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('A config reload is already running.')
    expect(refreshed.sort()).toEqual(['nested', 'root'])
    releaseRefresh()
    await tick()
    expect(result.terminal.output).toContain('Config reload complete.')
    // The guard released: a third /reload runs again.
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(refreshed).toHaveLength(4)
    await dispose(result)
  })

  it('reports a /reload failure if a refresh ever rejects', async () => {
    const result = await setup({
      configureContext: async (ctx) => {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('loader', {
          entries: () => [{ subtree: { refresh: () => Promise.reject(new Error('disk gone')) } }],
        } as never)
      },
    })
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('Config reload failed: disk gone')
    // The failure arm also releases the re-entrancy guard.
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).not.toContain('A config reload is already running.')
    await dispose(result)
  })

  it('refuses /reload while the agent is running and allows it back at idle', async () => {
    const refreshed: string[] = []
    const result = await setup({
      status: 'running',
      configureContext: async (ctx) => {
        ctx.provide('tools', { get: () => undefined } as never)
        ctx.provide('loader', {
          entries: () => [{ subtree: { refresh: async () => { refreshed.push('tree') } } }],
        } as never)
      },
    })
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(result.terminal.output).toContain('/reload requires an idle agent (status: running).')
    expect(refreshed).toHaveLength(0)
    // Back at idle the same command runs.
    result.agent.status = 'idle'
    result.terminal.send('/reload')
    result.terminal.send('\r')
    await tick()
    expect(refreshed).toHaveLength(1)
    expect(result.terminal.output).toContain('Config reload complete.')
    await dispose(result)
  })

})

describe('banner sweep reveal', () => {
  it('renders the product name through the brand-gradient path when truecolor is enabled', async () => {
    // The product name carries a per-letter 24-bit gradient from the brand
    // indigo to light blue; the per-letter layout is pinned by the
    // `banner-gradient` terminal snapshot.
    const result = await setup({ config: { color: true, truecolor: true } })
    expect(result.terminal.output).toContain('\x1b[38;2;77;107;254m')
    expect(result.terminal.output).toContain('\x1b[38;2;36;152;255m')
    expect(result.terminal.output).toContain('HARNESS')
    await dispose(result)
  })

  it('sweeps the whole borderless banner in when no welcome is configured, ending complete', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    const result = await setup({ omitWelcome: true })
    const revealHandle = intervals.mock.results.at(-1)?.value as ReturnType<typeof setInterval>
    // Run the sweep to natural completion — it clears its own timer at the end.
    const done = (): boolean => cleared.mock.calls.some(call => call[0] === revealHandle)
    const deadline = Date.now() + 5000
    while (!done() && Date.now() < deadline) await tick()
    intervals.mockRestore()
    cleared.mockRestore()
    // The finished banner carries the title and the model • session detail.
    expect(result.terminal.output).toContain('DEEPSEEK')
    expect(result.terminal.output).toContain('HARNESS')
    expect(result.terminal.output).toContain('main-session')
    // Borderless: no box-drawing frame around the banner.
    expect(result.terminal.output).not.toContain('╭')
    expect(result.terminal.output).not.toContain('╮')
    // A mid-sweep frame rendered a clipped title: `DEEPSEEK` with no `HARNESS`
    // on the same line.
    const clipped = result.terminal.output
      .split('\n')
      .some(line => line.includes('DEEPSEEK') && !line.includes('HARNESS'))
    expect(clipped).toBe(true)
    await dispose(result)
  })

  it('renders a configured welcome verbatim in a complete banner with no sweep', async () => {
    const result = await setup()
    await tick()
    expect(result.terminal.output).toContain('Coding agent ready.')
    expect(result.terminal.output).toContain('DEEPSEEK')
    expect(result.terminal.output).not.toContain('╭')
    // No reveal frames: the banner is drawn whole from the first render, so no
    // clipped-title frame ever appears.
    const clipped = result.terminal.output
      .split('\n')
      .some(line => line.includes('DEEPSEEK') && !line.includes('HARNESS'))
    expect(clipped).toBe(false)
    await dispose(result)
  })

  it('omits the subtitle line entirely when no welcome is configured', async () => {
    const result = await setup({ omitWelcome: true })
    const deadline = Date.now() + 5000
    while (!result.terminal.output.includes('main-session') && Date.now() < deadline) await tick()
    // Banner is title + detail only — no subtitle between them.
    expect(result.terminal.output).toContain('deepseek-v4-flash')
    expect(result.terminal.output).not.toContain('ready.')
    await dispose(result)
  })

  it('stops a mid-sweep animation on dispose', async () => {
    // The output-stability probe alone is insensitive to a leaked interval
    // (pi-tui's stopped guard silences post-stop renders), so capture the
    // reveal's own interval handle and assert dispose clears exactly it.
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const result = await setup({ omitWelcome: true })
    const revealHandle = intervals.mock.results.at(-1)?.value as ReturnType<typeof setInterval>
    expect(revealHandle).toBeDefined()
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    await dispose(result)
    expect(cleared.mock.calls.some(call => call[0] === revealHandle)).toBe(true)
    intervals.mockRestore()
    cleared.mockRestore()
    const settled = result.terminal.output.length
    await tick()
    await tick()
    expect(result.terminal.output.length).toBe(settled)
  })
})
