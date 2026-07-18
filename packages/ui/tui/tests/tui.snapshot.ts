import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolDefinition, type ToolResultView } from '@deepseek-ai/dsh-tools'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  type TuiHarness,
  type TuiHarnessOptions,
} from './harness.ts'
import { HeadlessTerminal, type TerminalSnapshotOptions } from './headless-terminal.ts'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const REFRESHING = process.env.DSH_SNAPSHOT === 'refresh'

const CHECKPOINTS = [
  'conversation-replay',
  'conversation-streaming',
  'conversation-complete',
  'code-mode-pending',
  'code-mode-complete',
  'dynamic-workflow-pending',
  'dynamic-workflow-complete',
  'cordis-tools-pending',
  'cordis-tools-complete',
  'advanced-cards-collapsed',
  'advanced-cards-expanded',
  'question-dialog',
  'question-dialog-validation',
  'surface-before-compaction',
  'surface-after-compaction-narrow',
  'surface-after-compaction-wide',
  'errors-and-help',
  'disposed-terminal',
] as const

type Checkpoint = typeof CHECKPOINTS[number]
type SnapshotHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

const observedCheckpoints = new Set<Checkpoint>()

async function checkpoint(
  name: Checkpoint,
  terminal: HeadlessTerminal,
  options: TerminalSnapshotOptions = {},
): Promise<void> {
  observedCheckpoints.add(name)
  expect(terminal.themeViolations(), `${name} must remain theme-agnostic`).toEqual([])
  const snapshot = await terminal.snapshot(options)
  const path = join(SNAPSHOTS_DIR, `${name}.golden.txt`)
  if (REFRESHING) {
    await mkdir(SNAPSHOTS_DIR, { recursive: true })
    await writeFile(path, snapshot)
  }
  await expect(snapshot).toMatchFileSnapshot(path)
}

async function setupSnapshot(
  options: TuiHarnessOptions = {},
  size: { columns?: number; rows?: number } = {},
): Promise<SnapshotHarness> {
  const terminal = new HeadlessTerminal(size.columns ?? 96, size.rows ?? 36)
  const before = terminal.frames
  const result = await createTuiTestHarness(terminal, () => {}, {
    ...options,
    cwd: options.cwd === undefined ? '/workspace/project' : options.cwd,
    config: Object.assign({
      welcome: 'Snapshot agent ready.',
      color: true,
      title: 'DSH snapshot',
    }, options.config),
  })
  await terminal.waitForFrame(before)
  return result
}

async function renderAfter(harness: SnapshotHarness, action: () => void): Promise<void> {
  const before = harness.terminal.frames
  action()
  await harness.terminal.waitForFrame(before)
}

async function disposeSnapshot(harness: SnapshotHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

async function configureAdvancedTools(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry, { mode: 'code' })
  ctx.provide('workflows', {} as never)
  await ctx.plugin(ToolWorkflow, { toolName: 'workflow', maxResultChars: 50_000 })
  await ctx.plugin(ToolCordis, { vmTimeoutMs: 5_000 })
}

interface ToolCallFixture {
  id: string
  name: string
  arguments: unknown
}

function appendToolCalls(session: Session, calls: readonly ToolCallFixture[]): void {
  appendAssistant(session, calls.map(call => ({
    type: 'tool-call',
    id: CallId(call.id),
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  })))
  for (const call of calls) {
    session.append('tool/call', {
      turn: 1,
      step: 0,
      callId: CallId(call.id),
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })
  }
}

function appendToolResult(
  session: Session,
  id: string,
  content: ContentBlock[],
  options: { isError?: boolean; meta?: unknown } = {},
): void {
  session.append('tool/result', {
    turn: 1,
    step: 0,
    callId: CallId(id),
    content,
    isError: options.isError ?? false,
    ...options.meta === undefined ? {} : { meta: options.meta },
  }, { surfaceOp: 'append' })
}

function visualTool(
  name: string,
  call: NonNullable<ToolDefinition['presentCall']>,
  result?: NonNullable<ToolDefinition['presentResult']>,
): ToolDefinition {
  return {
    name,
    description: `${name} snapshot fixture`,
    parameters: {},
    execute: () => Promise.resolve([]),
    presentCall: call,
    ...result === undefined ? {} : { presentResult: result },
  }
}

const ADVANCED_CARD_TOOLS: Record<string, ToolDefinition> = {
  bash: visualTool(
    'bash',
    () => ({ card: 'terminal', title: 'pnpm run test:coverage', description: 'Run the coverage gate', cwd: '/workspace/project' }),
    () => ({ card: 'terminal', output: 'packages/ui/tui 100%\n4016 tests passed\n1 test skipped\ncoverage complete', exitCode: 0 }),
  ),
  edit: visualTool(
    'edit',
    () => ({ card: 'diff', title: 'Edit renderer', diffs: [{ path: 'src/view.ts', oldText: 'old line', newText: 'new line' }] }),
    (): ToolResultView => ({
      card: 'diff',
      diffs: [
        { path: 'src/view.ts', oldText: 'old line\nkeep', newText: 'new line\nkeep' },
        { path: 'tests/view.spec.ts', oldText: null, newText: 'expect(screen).toMatchSnapshot()' },
      ],
    }),
  ),
  subagent: visualTool('subagent', args => ({
    card: 'generic',
    title: 'Delegate renderer audit',
    rawInput: (args as { prompt: string }).prompt,
  })),
  task_output: visualTool('task_output', args => ({
    card: 'generic',
    kind: 'read',
    title: `Read output from background task ${(args as { task_id: string }).task_id}`,
    rawInput: (args as { task_id: string }).task_id,
  })),
  skill: visualTool('skill', args => ({
    card: 'generic',
    kind: 'read',
    title: `Load skill ${(args as { name: string }).name}`,
    rawInput: (args as { name: string }).name,
  })),
}

describe('TUI terminal-state snapshots', () => {
  it('pins resumed conversation, streaming, completion, plans, tokens, and Markdown', async () => {
    const harness = await setupSnapshot({
      beforeMount(session) {
        appendUser(session, 'Explain **snapshot fidelity** with `cells`.')
        appendAssistant(session, [
          { type: 'reasoning', text: 'Compare the terminal state, not write fragments.' },
          { type: 'text', text: '## Result\n\n- final viewport\n- semantic styles\n\n> deterministic and reviewable' },
        ], { inputTokens: 12_500, outputTokens: 640 })
        session.append('todo/write', {
          todos: [
            { content: 'model the terminal', status: 'completed' },
            { content: 'capture advanced states', status: 'in_progress' },
            { content: 'verify PTY cleanup', status: 'pending' },
          ],
        })
      },
    })
    await checkpoint('conversation-replay', harness.terminal)

    await renderAfter(harness, () => {
      appendUser(harness.session, 'Show the live update.')
      harness.session.append('assistant/chunk', {
        turn: 2,
        step: 0,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      })
      harness.session.append('assistant/chunk', {
        turn: 2,
        step: 0,
        chunk: { type: 'reasoning-delta', index: 0, text: 'Inspecting width and styles.' },
      })
      harness.session.append('assistant/chunk', {
        turn: 2,
        step: 0,
        chunk: { type: 'block-start', index: 1, blockType: 'text' },
      })
      harness.session.append('assistant/chunk', {
        turn: 2,
        step: 0,
        chunk: { type: 'text-delta', index: 1, text: 'Streaming **visible state**…' },
      })
    })
    await checkpoint('conversation-streaming', harness.terminal)

    await renderAfter(harness, () => {
      appendAssistant(harness.session, [
        { type: 'reasoning', text: 'Inspecting width and styles.' },
        { type: 'text', text: 'Streaming **visible state** is complete.' },
      ], { inputTokens: 800, outputTokens: 120 })
      harness.session.append('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
    })
    await checkpoint('conversation-complete', harness.terminal)
    await disposeSnapshot(harness)
  })

  it('pins Code Mode run_code with its production presenter', async () => {
    const harness = await setupSnapshot({ configureContext: configureAdvancedTools })
    const call = {
      id: 'code-1',
      name: 'run_code',
      arguments: {
        code: "const first = await tools.bash({ command: 'echo CODE_ONE' })\nconst second = await tools.bash({ command: 'echo CODE_TWO' })\nconsole.log(first, second)\nreturn `${first}+${second}`",
      },
    }
    await renderAfter(harness, () => { appendToolCalls(harness.session, [call]) })
    await checkpoint('code-mode-pending', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => {
      appendToolResult(harness.session, call.id, [{ type: 'text', text: 'CODE_ONE\n+CODE_TWO' }], {
        meta: { logs: ['CODE_ONE', 'CODE_TWO', 'combined: CODE_ONE+CODE_TWO'] },
      })
    })
    await checkpoint('code-mode-complete', harness.terminal, { includeScrollback: true })
    await disposeSnapshot(harness)
  })

  it('pins a dynamic workflow with phases, parallel agents, and structured output', async () => {
    const harness = await setupSnapshot({ configureContext: configureAdvancedTools })
    const call = {
      id: 'workflow-1',
      name: 'workflow',
      arguments: {
        meta: {
          name: 'tui-matrix',
          description: 'Audit terminal states from independent angles',
          phases: [
            { title: 'Inspect', detail: 'Map renderer branches' },
            { title: 'Verify', detail: 'Challenge missing states', provider: 'deepseek', model: 'deepseek-v4-flash' },
          ],
        },
        args: { packages: ['ui/tui', 'workflow/tool-workflow'] },
        script: "phase('Inspect')\nconst reports = await parallel([\n  () => agent('Audit layout', { label: 'layout', phase: 'Inspect' }),\n  () => agent('Audit lifecycle', { label: 'lifecycle', phase: 'Inspect' }),\n])\nphase('Verify')\nreturn { reports, verdict: 'covered' }",
      },
    }
    await renderAfter(harness, () => { appendToolCalls(harness.session, [call]) })
    await checkpoint('dynamic-workflow-pending', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => {
      appendToolResult(harness.session, call.id, [{
        type: 'text',
        text: 'workflow "tui-matrix" completed (2 agents).\nReturn value:\n{\n  "reports": ["layout ok", "lifecycle ok"],\n  "verdict": "covered"\n}',
      }])
    })
    await checkpoint('dynamic-workflow-complete', harness.terminal, { includeScrollback: true })
    await disposeSnapshot(harness)
  })

  it('pins cordis inspect, dynamic mount, and unmount cards with production presenters', async () => {
    const harness = await setupSnapshot({ configureContext: configureAdvancedTools })
    const calls = [
      { id: 'cordis-1', name: 'cordis_inspect', arguments: { what: 'tools' } },
      {
        id: 'cordis-2',
        name: 'cordis_mount',
        arguments: { code: "return { name: 'snapshot-marker', apply(ctx) { ctx.provide('snapshotMarker', { ready: true }) } }" },
      },
      { id: 'cordis-3', name: 'cordis_unmount', arguments: { id: 'dyn-1' } },
    ]
    await renderAfter(harness, () => { appendToolCalls(harness.session, calls) })
    await checkpoint('cordis-tools-pending', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => {
      appendToolResult(harness.session, 'cordis-1', [{ type: 'text', text: '## tools\nrun_code\nworkflow\ncordis_mount\ncordis_unmount' }])
      appendToolResult(harness.session, 'cordis-2', [{ type: 'text', text: 'mounted dyn-1 (plugin "snapshot-marker", state: active)' }])
      appendToolResult(harness.session, 'cordis-3', [{ type: 'text', text: 'unmounted dyn-1 (plugin "snapshot-marker")' }])
    })
    await checkpoint('cordis-tools-complete', harness.terminal, { includeScrollback: true })
    await disposeSnapshot(harness)
  })

  it('pins terminal, diff, subagent, task, skill, collapsed, and expanded cards', async () => {
    const harness = await setupSnapshot({
      tools: ADVANCED_CARD_TOOLS,
      config: { maxToolOutputLines: 3 },
    }, { columns: 100, rows: 40 })
    const calls = [
      { id: 'advanced-1', name: 'bash', arguments: { command: 'pnpm run test:coverage' } },
      { id: 'advanced-2', name: 'edit', arguments: { file_path: 'src/view.ts' } },
      { id: 'advanced-3', name: 'subagent', arguments: { prompt: 'Review renderer ownership and report only gaps.' } },
      { id: 'advanced-4', name: 'task_output', arguments: { task_id: 'subagent-7', wait: true } },
      { id: 'advanced-5', name: 'skill', arguments: { name: 'dsh-code-review' } },
    ]
    await renderAfter(harness, () => {
      appendToolCalls(harness.session, calls)
      appendToolResult(harness.session, 'advanced-1', [{ type: 'text', text: 'raw process output' }])
      appendToolResult(harness.session, 'advanced-2', [{ type: 'text', text: 'edit complete' }])
      appendToolResult(harness.session, 'advanced-3', [{ type: 'text', text: 'The renderer has explicit lifecycle ownership.' }])
      appendToolResult(harness.session, 'advanced-4', [{ type: 'text', text: 'audit complete\n[status: completed]' }])
      appendToolResult(harness.session, 'advanced-5', [{ type: 'text', text: 'Loaded review instructions.' }])
    })
    await checkpoint('advanced-cards-collapsed', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => { harness.terminal.send('\x0f') })
    await checkpoint('advanced-cards-expanded', harness.terminal, { includeScrollback: true })
    await disposeSnapshot(harness)
  })

  it('pins a constrained multi-select question and its validation state', async () => {
    const harness = await setupSnapshot({
      config: {
        maxQuestionOptions: 3,
        questionDialogWidth: 48,
        questionDialogMaxHeight: 16,
      },
    }, { columns: 56, rows: 20 })
    const controller = new AbortController()
    const beforeQuestion = harness.terminal.frames
    const answer = harness.ctx.userInteraction.ask({
      questions: [{
        id: 'coverage',
        header: 'Coverage',
        question: 'Which advanced TUI states belong in the required matrix?',
        multiSelect: true,
        options: [
          { label: 'Code Mode', description: 'run_code programs and captured output' },
          { label: 'Workflows', description: 'phases and parallel agents' },
          { label: 'Cordis tools', description: 'inspect, mount, and unmount' },
          { label: 'Compaction', description: 'surface replacement and reflow' },
        ],
      }],
      signal: controller.signal,
    })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await harness.terminal.waitForFrame(beforeQuestion)
    await checkpoint('question-dialog', harness.terminal)

    await renderAfter(harness, () => { harness.terminal.send('\r') })
    await checkpoint('question-dialog-validation', harness.terminal)
    controller.abort()
    await rejected
    await disposeSnapshot(harness)
  })

  it('pins compaction surface replacement and narrow-to-wide reflow', async () => {
    let replacementStart = 0
    let replacementEnd = 0
    let replacementSources: number[] = []
    const harness = await setupSnapshot({
      tools: ADVANCED_CARD_TOOLS,
      beforeMount(session) {
        const user = session.append('user/message', {
          content: [{ type: 'text', text: 'Old prompt with a long line that exercises wrapping before compaction.' }],
          source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        const assistant = session.append('assistant/message', {
          turn: 1,
          step: 0,
          provenance: { provider: 'mock', model: 'deepseek-v4-flash' },
          content: [{ type: 'tool-call', id: CallId('old-tool'), name: 'bash', arguments: '{}' }],
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 0, callId: CallId('old-tool'), name: 'bash', arguments: '{}' })
        const result = session.append('tool/result', {
          turn: 1,
          step: 0,
          callId: CallId('old-tool'),
          content: [{ type: 'text', text: 'obsolete output that must disappear' }],
          isError: false,
        }, { surfaceOp: 'append' })
        replacementStart = user.seq
        replacementEnd = result.seq
        replacementSources = [user.seq, assistant.seq, result.seq]
      },
    }, { columns: 80, rows: 24 })
    await checkpoint('surface-before-compaction', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => {
      harness.session.append('context/message', {
        content: [{ type: 'text', text: 'Compacted summary: the prior command completed and its details were retired from the active surface.' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }, {
        surfaceOp: { op: 'replace', start: replacementStart, end: replacementEnd },
        sourceEventSeqs: replacementSources,
      })
      harness.terminal.resize(44, 18)
    })
    await checkpoint('surface-after-compaction-narrow', harness.terminal, { includeScrollback: true })

    await renderAfter(harness, () => { harness.terminal.resize(104, 30) })
    await checkpoint('surface-after-compaction-wide', harness.terminal, { includeScrollback: true })
    await disposeSnapshot(harness)
  })

  it('pins help, unknown commands, live errors, turn failures, and terminal restoration', async () => {
    const harness = await setupSnapshot({}, { columns: 92, rows: 32 })
    await renderAfter(harness, () => {
      harness.terminal.send('/help')
      harness.terminal.send('\r')
      harness.terminal.send('/unknown-advanced-command')
      harness.terminal.send('\r')
      harness.ctx.emit('agent/error', harness.agent, 3, 1, new Error('provider stream failed after partial output'))
      harness.session.append('turn/end', {
        turn: 3,
        reason: { kind: 'error', step: 1, message: 'provider stream failed after partial output' },
      })
      harness.session.append('turn/end', {
        turn: 4,
        reason: { kind: 'interrupted' },
      })
    })
    await checkpoint('errors-and-help', harness.terminal, { includeScrollback: true })

    await harness.controller.dispose()
    await harness.terminal.flush()
    await checkpoint('disposed-terminal', harness.terminal, { includeScrollback: true })
    await harness.ctx.fiber.dispose()
    await harness.terminal.dispose()
  })
})

afterAll(async () => {
  expect([...observedCheckpoints].sort()).toEqual([...CHECKPOINTS].sort())
  const files = (await readdir(SNAPSHOTS_DIR))
    .filter(file => file.endsWith('.golden.txt'))
    .sort()
  expect(files).toEqual(CHECKPOINTS.map(name => `${name}.golden.txt`).sort())
})
