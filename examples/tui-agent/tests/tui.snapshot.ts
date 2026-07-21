import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentCore from '@deepseek-ai/dsh-agent-spine-demo'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import WorkerCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker'
import CommandService from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import TokenMeterService from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { createTuiChat } from '@deepseek-ai/dsh-tui'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import WorkerWorkflowEngine from '@deepseek-ai/dsh-workflow-workerthread'
import { HeadlessTerminal } from '../../../packages/ui/tui/tests/headless-terminal.ts'

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
// Keep pre-normalization layout widths identical across macOS and Linux.
const SNAPSHOT_TMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp'
const PROVIDERS = [{ id: 'deepseek', models: [{ id: 'deepseek-v4-flash' }] }]
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

type SnapshotMode = 'replay' | 'record' | 'refresh'
type Composition = 'native' | 'code' | 'advanced'

interface Scenario {
  name: string
  composition: Composition
  expectedTools: string[]
  expectedEventCounts?: Record<string, number>
  childSessions?: number
  recorded: boolean
  seedWorkspace?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'multi-turn-conversation',
    composition: 'native',
    expectedTools: [],
    recorded: true,
  },
  {
    name: 'todo-plan',
    composition: 'native',
    expectedTools: ['todo_write'],
    expectedEventCounts: { 'todo/write': 1 },
    recorded: true,
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
    name: 'code-mode',
    composition: 'code',
    expectedTools: ['run_code'],
    expectedEventCounts: { 'tool/code-dispatch': 2 },
    recorded: true,
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

function scenarioDir(scenario: Scenario): string {
  return join(SNAPSHOTS_DIR, scenario.name)
}

function childFixturePaths(scenario: Scenario): string[] {
  return Array.from(
    { length: scenario.childSessions ?? 0 },
    (_, index) => join(scenarioDir(scenario), `session.${index + 1}.jsonl`),
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
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

function normalizeTerminalSnapshot(snapshot: string, cwd: string): string {
  return snapshot
    .split(`/private${cwd}`).join('/workspace/project')
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

async function mountScenarioContext(
  scenario: Scenario,
  cwd: string,
  fixtureFile: string,
  childFiles: string[],
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentCore, {
    agents: [],
    dshHome: join(cwd, '.dsh'),
    workspaceContext: false,
    tools: { mode: scenario.composition === 'code' ? 'code' : scenario.composition === 'advanced' ? 'both' : 'native' },
    skills: { local: { agentsHome: join(cwd, '.agents') } },
  })
  await ctx.plugin(TokenMeterService)
  await ctx.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(ToolTodo)
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent', enableRunInBackground: false })
  await ctx.plugin(WorkerWorkflowEngine, { provider: 'spawn' })
  await ctx.plugin(ToolWorkflow)
  await ctx.plugin(ToolRalph)
  await ctx.plugin(CommandService)
  if (scenario.composition === 'code' || scenario.composition === 'advanced') {
    await ctx.plugin(WorkerCodeRuntime, {})
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
  const dir = scenarioDir(scenario)
  const fixtureFile = join(dir, 'session.jsonl')
  const childFiles = childFixturePaths(scenario)
  const fixture = await readFile(fixtureFile, 'utf8')
  const prompts = userPrompts(fixture)
  expect(prompts.length, `${scenario.name} must carry at least one recorded user prompt`).toBeGreaterThan(0)

  const cwd = await mkdtemp(join(SNAPSHOT_TMP_ROOT, `dsh-tui-snapshot-${scenario.name}-`))
  let ctx: Context | undefined
  let controller: ReturnType<typeof createTuiChat> | undefined
  const terminal = new HeadlessTerminal(100, 36)
  try {
    if (scenario.seedWorkspace === true) {
      const source = join(scenarioDir(scenario), 'workspace')
      await cp(source, cwd, { recursive: true })
    }
    ctx = await mountScenarioContext(scenario, cwd, fixtureFile, childFiles)
    const disposedSessions: Session[] = []
    ctx.on('session/disposed', (session) => { disposedSessions.push(session) })
    const workflowEvents: string[] = []
    for (const name of ['workflow/start', 'workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
      ctx.on(name, () => { workflowEvents.push(name) })
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId('main-session'),
      meta: { cwd },
      agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    const agent: Agent = handle.agent
    controller = createTuiChat(ctx, {
      sessionId: 'main-session',
      color: true,
      showReasoning: true,
      title: 'DSH TUI snapshot',
      welcome: `Recorded replay: ${scenario.name}`,
      maxToolOutputLines: 8,
    }, { terminal, exit: () => {} })
    await settleTerminal(terminal)

    for (const prompt of prompts) {
      terminal.send(prompt)
      terminal.send('\r')
      await agent.whenIdle()
      await settleTerminal(terminal)
    }

    const events: SessionEvent[] = [...agent.session.events]
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(scenario.expectedTools)
    for (const [type, count] of Object.entries(scenario.expectedEventCounts ?? {})) {
      expect(events.filter(event => event.type === type), `${scenario.name} must emit ${type}`).toHaveLength(count)
    }
    expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.isError)).toBe(true)
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
    const snapshot = normalizeTerminalSnapshot(
      await terminal.snapshot({ includeScrollback: true }),
      cwd,
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
  }
}

async function writeRecording(scenario: Scenario, result: ScenarioResult): Promise<void> {
  const dir = scenarioDir(scenario)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), scrubRequestHeaders(rawSessionLog(result.parent)))
  expect(result.children).toHaveLength(scenario.childSessions ?? 0)
  for (const [index, child] of result.children.entries()) {
    await writeFile(join(dir, `session.${index + 1}.jsonl`), scrubRequestHeaders(rawSessionLog(child)))
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
  expect([...observedScenarios].sort()).toEqual(SCENARIOS.map(scenario => scenario.name).sort())
  const directories = (await readdir(SNAPSHOTS_DIR, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  expect(directories).toEqual(SCENARIOS.map(scenario => scenario.name).sort())
  for (const scenario of SCENARIOS) {
    const expected = [
      'session.jsonl',
      'terminal.expected.txt',
      ...scenario.seedWorkspace === true ? ['workspace'] : [],
      ...Array.from({ length: scenario.childSessions ?? 0 }, (_, index) => `session.${index + 1}.jsonl`),
    ].sort()
    expect((await readdir(scenarioDir(scenario))).sort()).toEqual(expected)
    for (const fixture of ['session.jsonl', ...childFixturePaths(scenario).map(path => basename(path))]) {
      const content = await readFile(join(scenarioDir(scenario), fixture), 'utf8')
      expect(scrubRequestHeaders(content), `${scenario.name}/${fixture} carries request-header bulk`).toBe(content)
    }
  }
})
