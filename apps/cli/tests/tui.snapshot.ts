import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { scrubRequestHeaders, tokenizeSessionFixtureCwd } from '@deepseek-ai/dsh-acp-snapshot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentCore from '@deepseek-ai/dsh-agent-spine-demo'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import WorkerCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker'
import CommandService from '@deepseek-ai/dsh-commands'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compact-basic/src/summarizer.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import PlanModeService from '@deepseek-ai/dsh-plan-mode'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import { packChunkRuns, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { createTuiChat, FILE_REFERENCE_PROMPT, TuiPromptService } from '@deepseek-ai/dsh-tui'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import WorkerWorkflowEngine from '@deepseek-ai/dsh-workflow-workerthread'
import { HeadlessTerminal } from '../../../packages/ui/tui/tests/headless-terminal.ts'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
// Keep pre-normalization layout widths identical across macOS and Linux.
const SNAPSHOT_TMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp'
const PROVIDERS = [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000 }] }]
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

type SnapshotMode = 'replay' | 'record' | 'refresh'
type Composition = 'native' | 'code' | 'advanced'
type ScenarioInteraction = 'skill-invocation-policy'

interface Scenario {
  name: string
  /** Replay fixture owned by an earlier scenario, for a derived presentation case. */
  fixture?: string
  composition: Composition
  expectedTools: string[]
  expectedEventCounts?: Record<string, number>
  childSessions?: number
  enterPlanMode?: boolean
  leavePlanModeAfterFirstTurn?: boolean
  recorded: boolean
  seedWorkspace?: boolean
  /**
   * Load the opt-in `todo_write` tool for this scenario. The shipped TUI
   * config omits it, so only the todo-plan scenario (the enabled-path proof)
   * mounts it; the rest cover the default, todo-free composition.
   */
  enableTodo?: boolean
  /**
   * Mount the spill stack (local backend + policy) with this inline cap, as the
   * shipped configs do. The dispatch-spill scenario proves the durable
   * `tool/code-dispatch` copy of an oversized sub-result is bounded to a
   * preview + locator while the program value stays whole.
   */
  spillMaxInlineBytes?: number
  /** Run scenario-specific terminal input instead of replaying recorded user prompts. */
  interaction?: ScenarioInteraction
  /**
   * Mount a deterministic compaction backend plus `/compact`, then run the
   * human command with a held summary while a prompt and injected context
   * arrive. Proves queued input waits for the standalone bracket's durability
   * checkpoint instead of racing the replacement.
   */
  manualCompact?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    expectedEventCounts: { 'plan/mode': 2 },
    enterPlanMode: true,
    leavePlanModeAfterFirstTurn: true,
    recorded: true,
  },
  {
    name: 'queued-manual-compact',
    fixture: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    manualCompact: true,
  },
  {
    name: 'todo-plan',
    composition: 'native',
    expectedTools: ['todo_write'],
    expectedEventCounts: { 'todo/write': 1 },
    recorded: true,
    enableTodo: true,
  },
  {
    name: 'bash-terminal-card',
    composition: 'native',
    expectedTools: ['bash'],
    recorded: true,
  },
  {
    name: 'parallel-file-reads',
    composition: 'native',
    expectedTools: ['read', 'read'],
    recorded: true,
    seedWorkspace: true,
  },
  {
    name: 'skill-invocation-policy',
    composition: 'native',
    expectedTools: [],
    recorded: false,
    seedWorkspace: true,
    interaction: 'skill-invocation-policy',
  },
  {
    name: 'code-mode',
    composition: 'code',
    expectedTools: ['run_code'],
    expectedEventCounts: { 'tool/code-dispatch': 2 },
    recorded: true,
  },
  {
    name: 'code-mode-dispatch-spill',
    composition: 'code',
    expectedTools: ['run_code'],
    expectedEventCounts: { 'tool/code-dispatch-start': 1, 'tool/code-dispatch': 1 },
    recorded: true,
    spillMaxInlineBytes: 600,
  },
  {
    name: 'dynamic-workflow',
    composition: 'native',
    expectedTools: ['workflow'],
    childSessions: 1,
    recorded: true,
  },
  {
    name: 'cordis-dynamic-toolchain',
    composition: 'advanced',
    expectedTools: ['cordis_mount', 'run_code', 'subagent', 'workflow', 'cordis_unmount'],
    expectedEventCounts: { 'tool/code-dispatch': 1 },
    childSessions: 2,
    recorded: false,
  },
]

function snapshotModeFromEnv(value: string | undefined): SnapshotMode {
  if (value === undefined || value === '' || value === 'replay') return 'replay'
  if (value === 'record' || value === 'refresh') return value
  throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(value)}`)
}

const MODE = snapshotModeFromEnv(process.env.DSH_SNAPSHOT)
const observedScenarios = new Set<string>()
const workerState = Reflect.get(globalThis, '__vitest_worker__') as
  | { readonly config?: { readonly testNamePattern?: RegExp } }
  | undefined
// Worker argv omits the parent CLI's `-t`; the serialized runner config is the
// authoritative distinction between a focused replay and the full suite.
const TEST_NAME_FILTERED = workerState?.config?.testNamePattern !== undefined

/**
 * Deterministic keyless summary that pauses so the scenario can submit a real
 * prompt and inject context while manual compaction holds turn admission.
 */
class DeferredSnapshotCompactService extends BasicCompactService {
  readonly summaryStarted = Promise.withResolvers<undefined>()
  readonly releaseSummary = Promise.withResolvers<undefined>()

  override async summarize(
    _input: SummarizationInput,
    _agent: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: [{ type: 'text'; text: string }]; provider: string; model: string }> {
    this.summaryStarted.resolve(undefined)
    await this.releaseSummary.promise
    signal?.throwIfAborted()
    return {
      summary: [{ type: 'text', text: 'Keyless manual compaction checkpoint.' }],
      provider: 'snapshot',
      model: 'snapshot-compactor',
    }
  }
}

/** Seed between-turn model-visible history without inventing a loop execution. */
function seedCompactableHistory(agent: Agent): void {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'Older snapshot context. '.repeat(60) }],
    source: { kind: 'plugin', plugin: 'snapshot-seed' },
  }))
}

function snapshotDisplayPath(displayPath: string, cwd: string, displayCwd: string): string {
  const rel = relative(cwd, displayPath)
  if (rel === '') return displayCwd
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return displayPath
  return `${displayCwd}/${rel.split(sep).join('/')}`
}

function scenarioDir(scenario: Scenario): string {
  return join(SNAPSHOTS_DIR, scenario.name)
}

/** Directory owning the replay fixture: the scenario's own, or the one it derives from. */
function fixtureDir(scenario: Scenario): string {
  return join(SNAPSHOTS_DIR, scenario.fixture ?? scenario.name)
}

function childFixturePaths(scenario: Scenario): string[] {
  return Array.from(
    { length: scenario.childSessions ?? 0 },
    (_, index) => join(fixtureDir(scenario), `session.${index + 1}.jsonl`),
  )
}

function userPrompts(rawLog: string): string[] {
  return parseSessionLog(rawLog).flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return text.length > 0 ? [text] : []
  })
}

function rawSessionLog(session: Session): string {
  return [
    JSON.stringify({ type: 'session', ...session.header }),
    ...packChunkRuns(session.events).map(record => JSON.stringify(record)),
    '',
  ].join('\n')
}

function normalizeTerminalSnapshot(snapshot: string, cwd: string, displayCwd: string): string {
  return snapshot
    .split(`/private${cwd}`).join('/workspace/project')
    .split(displayCwd).join('/workspace/project')
    .split(cwd).join('/workspace/project')
    .replace(UUID_RE, '{{uuid}}')
}

async function settleTerminal(terminal: HeadlessTerminal): Promise<void> {
  let stable = 0
  for (let attempt = 0; attempt < 20 && stable < 3; attempt++) {
    const before = terminal.frames
    await new Promise(resolve => setTimeout(resolve, 10))
    await terminal.flush()
    stable = terminal.frames === before ? stable + 1 : 0
  }
  if (stable < 3) throw new Error('TUI frames did not quiesce within 200ms')
}

/** Bound deterministic in-process coordination waits with actionable state. */
async function snapshotDeadline<T>(
  operation: Promise<T>,
  detail: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(detail())) }, 5_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function mountScenarioContext(
  scenario: Scenario,
  cwd: string,
  displayCwd: string,
  fixtureFile: string,
  childFiles: string[],
): Promise<Context> {
  class SnapshotLocalFileSystem extends LocalFileSystem {
    override async resolve(
      path: string,
      opts?: { cwd?: string; signal?: AbortSignal },
    ): Promise<Awaited<ReturnType<LocalFileSystem['resolve']>>> {
      const target = await super.resolve(path, opts)
      return { ...target, displayPath: snapshotDisplayPath(target.displayPath, cwd, displayCwd) }
    }
  }

  const ctx = new Context()
  await ctx.plugin(AgentCore, {
    agents: [],
    dshHome: join(cwd, '.dsh'),
    workspaceContext: false,
    tools: { mode: scenario.composition === 'code' ? 'code' : scenario.composition === 'advanced' ? 'both' : 'native' },
    skills: { local: { agentsHome: join(cwd, '.agents') } },
  })
  await ctx.plugin(TokenMeterService)
  if (scenario.manualCompact === true) {
    await ctx.plugin(DeferredSnapshotCompactService, { auto: false })
  }
  await ctx.plugin(LocalSubprocessService)
  await ctx.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  await ctx.plugin(SnapshotLocalFileSystem, { cwd: '/' })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(TuiPromptService)
  // todo_write is opt-in: only the todo-plan scenario mounts it, matching the shipped
  // config that omits it. The other scenarios prove the default todo-free composition.
  if (scenario.enableTodo === true) await ctx.plugin(ToolTodo)
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent', enableRunInBackground: false })
  await ctx.plugin(WorkerWorkflowEngine, { provider: 'spawn' })
  await ctx.plugin(ToolWorkflow)
  await ctx.plugin(ToolRalph)
  await ctx.plugin(CommandService)
  if (scenario.manualCompact === true) await ctx.plugin(CommandCompact)
  if (scenario.enterPlanMode === true) {
    await ctx.plugin(PlanModeService, { section: 'Snapshot plan mode instructions.' })
  }
  if (scenario.composition === 'code' || scenario.composition === 'advanced') {
    await ctx.plugin(WorkerCodeRuntime, {})
  }
  if (scenario.spillMaxInlineBytes !== undefined) {
    await ctx.plugin(LocalSpillStore, { root: join(cwd, '.spill') })
    await ctx.plugin(SpillPolicy, { maxInlineBytes: scenario.spillMaxInlineBytes })
  }
  if (scenario.composition === 'advanced') await ctx.plugin(ToolCordis, { vmTimeoutMs: 5_000 })
  if (MODE === 'record' && scenario.recorded) {
    await ctx.plugin(LlmDeepSeek)
  } else {
    installLlmReplay(ctx, { file: fixtureFile, childFiles, providers: PROVIDERS })
  }
  return ctx
}

interface ScenarioResult {
  terminal: string
  parent: Session
  children: Session[]
  workflowEvents: string[]
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 21, 12, 0, 0).getTime())
  const fixtureFile = join(fixtureDir(scenario), 'session.jsonl')
  const childFiles = childFixturePaths(scenario)
  const prompts = userPrompts(await readFile(fixtureFile, 'utf8'))
  if (scenario.interaction === undefined) {
    expect(prompts.length, `${scenario.name} must carry at least one recorded user prompt`).toBeGreaterThan(0)
  }

  const cwd = await mkdtemp(join(SNAPSHOT_TMP_ROOT, `dsh-tui-snapshot-${scenario.name}-`))
  const displayCwd = `/tmp/${basename(cwd)}`
  let ctx: Context | undefined
  let controller: ReturnType<typeof createTuiChat> | undefined
  const terminal = new HeadlessTerminal(100, 36)
  try {
    if (scenario.seedWorkspace === true) {
      const source = join(fixtureDir(scenario), 'workspace')
      await cp(source, cwd, { recursive: true })
    }
    ctx = await mountScenarioContext(scenario, cwd, displayCwd, fixtureFile, childFiles)
    const disposedSessions: Session[] = []
    ctx.on('session/disposed', (session) => { disposedSessions.push(session) })
    const workflowEvents: string[] = []
    for (const name of ['workflow/start', 'workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
      ctx.on(name, () => { workflowEvents.push(name) })
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId('main-session'),
      meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const agent: Agent = handle.agent
    if (scenario.manualCompact === true) seedCompactableHistory(agent)
    controller = createTuiChat(ctx, {
      sessionId: 'main-session',
      theme: { color: true },
      showReasoning: true,
      title: 'DSH TUI snapshot',
      welcome: `Recorded replay: ${scenario.name}`,
      maxToolOutputLines: 8,
    }, {
      terminal,
      exit: () => {},
      formatCwd: () => displayCwd,
    })
    await settleTerminal(terminal)

    let interactionSnapshot: string | undefined
    if (scenario.interaction === 'skill-invocation-policy') {
      terminal.send('/skill')
      await settleTerminal(terminal)
      const discovery = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(discovery).toContain('user-only-skill')
      expect(discovery).not.toContain('model-only-skill')

      terminal.send('\x03')
      await settleTerminal(terminal)
      const skillContext = ctx
      const skillTurnEnded = new Promise<void>((resolve) => {
        const detach = skillContext.on('session/event', (session, event) => {
          if (session !== agent.session || event.type !== 'turn/end') return
          detach()
          resolve()
        })
      })
      terminal.send('/skill:user-only-skill')
      terminal.send('\r')
      await skillTurnEnded
      await agent.whenIdle()
      await settleTerminal(terminal)
      const loaded = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(loaded).toContain('USER-ONLY SKILL LOADED')

      terminal.send('/skill:model-only-skill')
      terminal.send('\r')
      await settleTerminal(terminal)
      const denied = normalizeTerminalSnapshot(
        await terminal.snapshot({ includeScrollback: true }),
        cwd,
        displayCwd,
      )
      expect(denied).toContain('model-only-skill')
      expect(denied).toContain('not available for user invocation.')
      expect(denied).not.toContain('MODEL-ONLY BODY MUST NOT LOAD')
      interactionSnapshot = [
        '=== skill autocomplete ===',
        discovery,
        '',
        '=== loaded exact invocation ===',
        loaded,
        '',
        '=== denied exact invocation ===',
        denied,
      ].join('\n')
    }

    let remainingPrompts = prompts
    let queuedPrompt: string | undefined
    let manualOrder: string[] | undefined
    let manualCommandId: string | undefined
    if (scenario.manualCompact === true) {
      expect(prompts.length, 'queued manual compaction needs a second replayed prompt').toBeGreaterThanOrEqual(2)
      queuedPrompt = prompts.at(-1)
      remainingPrompts = prompts.slice(0, -1)
    }
    if (scenario.enterPlanMode === true) {
      const firstPrompt = prompts[0]!
      terminal.send(`/plan ${firstPrompt}`)
      terminal.send('\r')
      await agent.whenIdle()
      await settleTerminal(terminal)
      remainingPrompts = prompts.slice(1)
    }

    if (scenario.leavePlanModeAfterFirstTurn === true) {
      terminal.send('/plan off')
      terminal.send('\r')
      await settleTerminal(terminal)
    }

    for (const prompt of remainingPrompts) {
      const admitted = agent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'user').length
      terminal.send(prompt)
      terminal.send('\r')
      await terminal.flush()
      await expect.poll(() => agent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'user').length).toBe(admitted + 1)
      await agent.whenIdle()
      await settleTerminal(terminal)
    }

    if (scenario.manualCompact === true && queuedPrompt !== undefined) {
      terminal.send('/help')
      terminal.send('\r')
      await settleTerminal(terminal)
      expect(await terminal.snapshot({ includeScrollback: true }))
        .toContain('/compact — Compact older conversation history')

      const compact = ctx.compact as DeferredSnapshotCompactService
      const inbox: string[] = []
      manualOrder = []
      ctx.on('agent/inbox/enqueue', (subject, item) => {
        if (subject === agent) inbox.push(`enqueue:${item.placement}:${item.id}`)
      })
      ctx.on('agent/inbox/dequeue', (subject, message) => {
        if (subject === agent) inbox.push(`dequeue:${message.id}`)
      })
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'command/run' && event.data.name === 'compact') {
          manualCommandId = event.data.commandId
          manualOrder?.push('command/run')
        }
        if (event.type === 'command/done' && event.data.commandId === manualCommandId) {
          manualOrder?.push('command/done')
        }
        if (event.type.startsWith('compact/')) manualOrder?.push(event.type)
        if (event.type === 'user/message'
          && event.data.source.kind === 'plugin'
          && event.data.source.plugin === 'compact') manualOrder?.push('checkpoint')
        if (event.type === 'turn/start') manualOrder?.push(`turn/start:${event.data.trigger.kind}`)
      })
      ctx.on('session/flush', (session) => {
        if (session === agent.session) manualOrder?.push('flush')
      })

      terminal.send('/compact')
      terminal.send('\r')
      await terminal.flush()
      await snapshotDeadline(compact.summaryStarted.promise, () =>
        `manual summary did not start; status=${agent.status}; tail=${
          agent.session.events.slice(-8).map(event => event.type).join(',')
        }`)

      // Real keystrokes: the prompt keeps its ordinary queue identity while
      // admission is reserved, and an injection appends immediately.
      terminal.send(queuedPrompt)
      terminal.send('\r')
      await terminal.flush()
      await expect.poll(() => inbox.length).toBe(1)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: 'Injected while compaction was running.' }],
        source: { kind: 'plugin', plugin: 'snapshot-injector' },
      }))
      expect(inbox[0]).toMatch(/^enqueue:queued:/u)
      expect(agent.status).toBe('idle')
      expect(agent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text === queuedPrompt))).toBe(false)

      const idle = agent.whenIdle()
      compact.releaseSummary.resolve(undefined)
      await snapshotDeadline(idle, () =>
        `manual compaction did not reach idle; status=${agent.status}; order=${manualOrder?.join(',') ?? ''}; tail=${
          agent.session.events.slice(-12).map(event => event.type).join(',')
        }`)
      await settleTerminal(terminal)
      expect(inbox).toEqual([inbox[0], `dequeue:${inbox[0]?.slice('enqueue:queued:'.length) ?? ''}`])
    }

    const events: SessionEvent[] = [...agent.session.events]
    const firstHeader = events.find(event => event.type === 'request/header')
    expect(firstHeader?.type === 'request/header' && firstHeader.data.header.system)
      .toContain(FILE_REFERENCE_PROMPT)
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(scenario.expectedTools)
    for (const [type, count] of Object.entries(scenario.expectedEventCounts ?? {})) {
      expect(events.filter(event => event.type === type), `${scenario.name} must emit ${type}`).toHaveLength(count)
    }
    if (scenario.enterPlanMode === true) {
      expect(ctx.planMode.get(agent)).toEqual({
        active: scenario.leavePlanModeAfterFirstTurn !== true,
      })
      const planMode = events.find(event => event.type === 'plan/mode')
      if (planMode === undefined || firstHeader === undefined) {
        throw new Error('plan-mode command snapshot needs plan/mode before its first request/header')
      }
      expect(planMode.seq).toBeLessThan(firstHeader.seq)
      expect(firstHeader.data.header.system).toContain('Snapshot plan mode instructions.')
      const firstMessage = events.find(event => event.type === 'user/message')
      expect(firstMessage?.data.content).toEqual([{ type: 'text', text: prompts[0] }])
    }
    if (scenario.leavePlanModeAfterFirstTurn === true) {
      const planModes = events.filter(event => event.type === 'plan/mode')
      expect(planModes.map(event => event.data.active)).toEqual([true, false])
      const headers = events.filter(event => event.type === 'request/header')
      const exit = planModes[1]
      const afterExit = headers[1]
      if (exit === undefined || afterExit === undefined) {
        throw new Error('active plan exit snapshot needs a committed exit and changed request header')
      }
      expect(exit.seq).toBeLessThan(afterExit.seq)
      expect(afterExit.data.header.system).not.toContain('Snapshot plan mode instructions.')
      expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin').map(event => (event.data as { content: unknown }).content))
        .toContainEqual([{ type: 'text', text: 'The user switched this session back to the default mode.' }])
    }
    if (scenario.manualCompact === true) {
      const compactStart = events.find(event => event.type === 'compact/start')
      const compactSummary = events.find(event => event.type === 'compact/summary')
      const compactCheckpoint = events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact')
      const injectedEvent = events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin' && event.data.source.plugin === 'snapshot-injector')
      const compactEnd = events.find(event => event.type === 'compact/end')
      expect(compactStart?.data.turn).toBeNull()
      expect(compactEnd?.data.turn).toBeNull()
      expect(events.filter(event => event.type === 'compact/summary')).toHaveLength(1)
      if (compactStart === undefined || compactSummary === undefined
        || compactCheckpoint === undefined || injectedEvent === undefined
        || compactEnd === undefined) {
        throw new Error('manual compaction snapshot is missing its durable marker, summary, checkpoint, or injection')
      }
      // The markers are time points, not an exclusive container: unrelated
      // idle injection is allowed between them while the selected span stays stable.
      expect(compactStart.seq).toBeLessThan(injectedEvent.seq)
      expect(injectedEvent.seq).toBeLessThan(compactSummary.seq)
      expect(compactSummary.seq).toBeLessThan(compactCheckpoint.seq)
      expect(compactCheckpoint.seq).toBeLessThan(compactEnd.seq)

      const manualTimeline = manualOrder ?? []
      const commandRunIndex = manualTimeline.indexOf('command/run')
      const compactStartIndex = manualTimeline.indexOf('compact/start')
      const compactEndIndex = manualTimeline.indexOf('compact/end')
      const firstFlushIndex = manualTimeline.indexOf('flush')
      const queuedTurnIndex = manualTimeline.indexOf('turn/start:message')
      const commandDoneIndex = manualTimeline.indexOf('command/done')
      expect(manualTimeline.filter(item => item === 'command/run')).toHaveLength(1)
      expect(manualTimeline.filter(item => item === 'command/done')).toHaveLength(1)
      expect(compactStartIndex).toBeGreaterThan(commandRunIndex)
      expect(compactEndIndex).toBeGreaterThan(compactStartIndex)
      expect(firstFlushIndex).toBeGreaterThan(compactEndIndex)
      expect(queuedTurnIndex).toBeGreaterThan(firstFlushIndex)
      expect(commandDoneIndex).toBeGreaterThan(firstFlushIndex)

      const commandRun = events.find(event => event.type === 'command/run'
        && event.data.name === 'compact')
      const commandRunId = commandRun?.type === 'command/run'
        ? commandRun.data.commandId
        : undefined
      const commandDone = events.find(event => event.type === 'command/done'
        && event.data.commandId === commandRunId)
      expect(commandRun?.type === 'command/run' && commandRun.data).toEqual({
        commandId: commandRunId,
        name: 'compact',
        args: '',
        source: { kind: 'user' },
      })
      expect(commandDone?.type === 'command/done' && commandDone.data).toEqual({
        commandId: commandRunId,
        kind: 'success',
        text: 'Compacted 2 history items (~387 tokens).',
      })
      expect(commandRun !== undefined && commandRun.seq < compactStart.seq).toBe(true)
      expect(commandDone !== undefined && commandDone.seq > compactEnd.seq).toBe(true)
      expect(agent.session.surface.nodes).not.toContain(commandRun?.seq)
      expect(agent.session.surface.nodes).not.toContain(commandDone?.seq)

      // The command line itself never becomes a prompt.
      expect(events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text.trim() === '/compact'))).toBe(false)
      const derived = agent.session.deriveMessages().map(message => message.content
        .map(block => block.type === 'text' ? block.text : '')
        .join(''))
      const checkpoint = derived.findIndex(text => text.includes('Keyless manual compaction checkpoint.'))
      const injected = derived.findIndex(text => text.includes('Injected while compaction was running.'))
      const queued = derived.findIndex(text => text === queuedPrompt)
      expect(checkpoint).toBe(0)
      expect(injected).toBeGreaterThan(checkpoint)
      expect(queued).toBeGreaterThan(injected)
      expect(derived).not.toContain('/compact')
      expect(derived).not.toContain('Compacted 2 history items (~387 tokens).')
      expect(derived.filter(text => text.includes('Injected while compaction was running.'))).toHaveLength(1)
      expect(compactSummary.data.shadowedSeqs).not.toContain(injectedEvent.seq)
      const queuedTurn = events.findLast(event => event.type === 'turn/start')
      expect(queuedTurn !== undefined && compactEnd.seq < queuedTurn.seq).toBe(true)
    }
    if (scenario.spillMaxInlineBytes !== undefined) {
      // The REAL pipeline ran (tools execute on replay too): the durable
      // dispatch copy is bounded to a preview + locator under the run cwd,
      // while the outer result still carries the program's whole value.
      const dispatch = events.find(event => (event.type as string) === 'tool/code-dispatch')
      const content = (dispatch?.data as { content: { type: string; text?: string }[] }).content
      const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(scenario.spillMaxInlineBytes)
      expect(text).toContain('Full formatted result stored at:')
      expect(text).toContain('.spill')
    }
    expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.content[0].isError)).toBe(true)
    expect(events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind !== 'error')).toBe(true)
    if (scenario.name === 'dynamic-workflow' || scenario.name === 'cordis-dynamic-toolchain') {
      expect(workflowEvents).toEqual([
        'workflow/start',
        'workflow/phase',
        'workflow/agent-start',
        'workflow/agent-end',
        'workflow/end',
      ])
    }

    expect(terminal.themeViolations(), `${scenario.name} must remain theme-agnostic`).toEqual([])
    const snapshot = interactionSnapshot ?? normalizeTerminalSnapshot(
      await terminal.snapshot({ includeScrollback: true }),
      cwd,
      displayCwd,
    )
    await handle.dispose()
    const children = disposedSessions
      .filter(session => session !== agent.session)
      .sort((a, b) => a.header.createdAt - b.header.createdAt)
    expect(children).toHaveLength(scenario.childSessions ?? 0)
    return { terminal: snapshot, parent: agent.session, children, workflowEvents }
  } finally {
    await controller?.dispose()
    await ctx?.fiber.dispose()
    await terminal.dispose()
    await rm(cwd, { recursive: true, force: true })
    clock.mockRestore()
  }
}

async function writeRecording(scenario: Scenario, result: ScenarioResult): Promise<void> {
  const dir = scenarioDir(scenario)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'session.jsonl'),
    scrubRequestHeaders(tokenizeSessionFixtureCwd(rawSessionLog(result.parent))),
  )
  expect(result.children).toHaveLength(scenario.childSessions ?? 0)
  for (const [index, child] of result.children.entries()) {
    await writeFile(
      join(dir, `session.${index + 1}.jsonl`),
      scrubRequestHeaders(tokenizeSessionFixtureCwd(rawSessionLog(child))),
    )
  }
}

describe('TUI recorded-session terminal snapshots', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      observedScenarios.add(scenario.name)
      const result = await runScenario(scenario)
      const terminalFile = join(scenarioDir(scenario), 'terminal.expected.txt')
      if (MODE === 'record' || MODE === 'refresh') {
        await mkdir(scenarioDir(scenario), { recursive: true })
        await writeFile(terminalFile, result.terminal)
      }
      if (MODE === 'record' && scenario.recorded) await writeRecording(scenario, result)
      await expect(result.terminal).toMatchFileSnapshot(terminalFile)
    }, 120_000)
  }
})

afterAll(async () => {
  const scenarioNames = SCENARIOS.map(scenario => scenario.name).sort()
  const observedNames = [...observedScenarios].sort()
  if (TEST_NAME_FILTERED) {
    expect(observedNames).not.toHaveLength(0)
    expect(scenarioNames).toEqual(expect.arrayContaining(observedNames))
  } else {
    expect(observedNames).toEqual(scenarioNames)
  }
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (scenario.fixture === undefined) continue
    const sourceIndex = SCENARIOS.findIndex(candidate => candidate.name === scenario.fixture)
    expect(sourceIndex, `${scenario.name} fixture source ${scenario.fixture} must exist`).toBeGreaterThanOrEqual(0)
    expect(sourceIndex, `${scenario.name} fixture source must precede it`).toBeLessThan(index)
    const source = SCENARIOS[sourceIndex]
    expect(source?.fixture, `${scenario.name} fixture source must own its replay files`).toBeUndefined()
    expect(source?.recorded, `${scenario.name} fixture source must be recordable`).toBe(true)
  }
  const directories = (await readdir(SNAPSHOTS_DIR, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  expect(directories).toEqual(SCENARIOS.map(scenario => scenario.name).sort())
  for (const scenario of SCENARIOS) {
    const expected = [
      ...scenario.fixture === undefined ? ['session.jsonl'] : [],
      'terminal.expected.txt',
      ...scenario.seedWorkspace === true && scenario.fixture === undefined ? ['workspace'] : [],
      ...Array.from({ length: scenario.childSessions ?? 0 }, (_, index) => `session.${index + 1}.jsonl`),
    ].sort()
    expect((await readdir(scenarioDir(scenario))).sort()).toEqual(expected)
    for (const fixture of ['session.jsonl', ...childFixturePaths(scenario).map(path => basename(path))]) {
      const content = await readFile(join(fixtureDir(scenario), fixture), 'utf8')
      expect(scrubRequestHeaders(content), `${scenario.name}/${fixture} carries request-header bulk`).toBe(content)
    }
  }
})
