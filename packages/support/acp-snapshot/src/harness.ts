/**
 * Shared ACP snapshot subprocess harness. It boots the real agent bin through the Cordis
 * loader, drives deterministic ACP JSON-RPC over stdio, captures protocol-pure stdout, and
 * harvests persisted session logs after graceful shutdown. Normalization stays in
 * `normalize.ts`; suite registration stays in `suite.ts`.
 * @module @deepseek-ai/dsh-acp-snapshot/harness
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

// Resolve tsx's ESM loader to an ABSOLUTE path once: the child runs with its
// cwd in a temp dir OUTSIDE the repo, where a bare `--import tsx` would not
// resolve from node_modules. import.meta.resolve gives this package's tsx
// regardless of the child cwd.
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))

/**
 * The agent composition a scenario runs against: which bin to boot and which
 * leaf config it loads. All paths are ABSOLUTE — the subprocess cwd is a temp
 * dir outside the repo, so relative resolution would miss; a suite resolves
 * them from its own `import.meta.url`.
 */
export interface AgentUnderTest {
  /** The agent bin entry (e.g. `packages/examples/acp-demo/src/bin.ts`), run unbuilt via tsx. */
  binScript: string
  /**
   * The example's live `cordis.yml`. Under `DSH_SNAPSHOT=replay` the bin swaps
   * it for the sibling `cordis.snapshot.yml` (the keyless replay overlay), so
   * one path serves both modes.
   */
  configPath: string
  /**
   * The repo-root tsconfig whose `paths` map resolves the unbuilt workspace
   * imports. Passed to the child as `TSX_TSCONFIG_PATH`: tsx finds a tsconfig
   * by searching UP from the child's cwd — a temp dir outside the repo — so
   * without the explicit pin the dsh-* imports fail before the bin writes a
   * byte.
   */
  tsconfigPath: string
}

/**
 * One step of a scenario's deterministic input script (`input.json`). The harness interprets
 * these in order. `newSession` captures the server-issued (random) session id into a
 * `{{sessionId}}` variable that later steps reference. `promptAndCancel` sends without awaiting,
 * waits for the first streamed message, then cancels, making transcript order deterministic.
 */
export type InputStep =
  | { op: 'initialize'; terminalOutput?: boolean }
  | { op: 'newSession' }
  | { op: 'newSessionExpectError'; additionalDirectories?: string[] }
  | { op: 'prompt'; text: string }
  | { op: 'promptExpectError'; text: string }
  | { op: 'promptAndCancel'; text: string }
  | { op: 'cancel' }
  | { op: 'setConfigOption'; configId: string; value: string }
  | { op: 'setConfigOptionExpectError'; configId: string; value: string }

/** A scenario's `input.json`: an ordered list of input steps. */
export interface InputScript {
  steps: InputStep[]
  /**
   * FIFO permission answers selected by stable option kind; the harness maps each kind to the
   * agent-issued option id. Exhaustion cancels, while a kind the agent did not offer fails the
   * scenario.
   */
  permissionAnswers?: PermissionAnswer[]
}

/** One scripted answer to a permission request: which offered option kind to select. */
export interface PermissionAnswer {
  /** The `PermissionOption.kind` to select (`allow_once`, `reject_always`, …). */
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** One harvested session log plus the identifying facts off its header line. */
export interface HarvestedLog {
  /** The recorded session id (header `id`). */
  id: string
  /** Session creation time (header `createdAt`) — the child-ordering key. */
  createdAt: number
  /** The parent session id, if this log is a subagent child (header `parentSession`). */
  parentSession?: string
  /** The full `.jsonl` file content. */
  content: string
}

/** The result of running a scenario: raw stdout + the harvested session log(s). */
export interface RunResult {
  /** Raw stdout bytes (decoded utf8), every newline-delimited JSON-RPC frame. */
  rawStdout: string
  /** stderr (for diagnostics on failure). */
  stderr: string
  /** The session id the server issued (undefined if no session was created). */
  sessionId?: string
  /** The temp cwd the session ran in (the bash workspace). */
  cwd: string
  /**
   * Every persisted session log harvested after the run, ordered primary-first:
   * the top-level (parent) session — the one with no `parentSession` — then each
   * subagent child by ascending `createdAt`. A single-session scenario harvests
   * exactly one; a nested-agent scenario harvests the parent plus one per child.
   */
  sessionLogs: HarvestedLog[]
}

/** How to run one scenario: the agent to boot, the mode, and the fixture wiring. */
export interface RunOptions {
  /** The agent composition to boot. */
  agent: AgentUnderTest
  /** `replay` (default, keyless) or `record` (real API, harvests the log). */
  mode: 'replay' | 'record'
  /** The recorded session JSONL fixture path (replay reads it; record writes near it). */
  fixtureFile: string
  /** Optional sidecar override path (replay). */
  overrideFile?: string
  /**
   * Recorded SUBAGENT child-session fixture paths (replay). A nested-agent
   * scenario ships one per child (`session.1.jsonl`, …); the harness forwards
   * them to `dsh-llm-replay` via `$DSH_SNAPSHOT_CHILD_FILES` so each child
   * session replays from its own recorded script. Empty for single-session
   * scenarios. Ignored in record mode (children are harvested, not replayed).
   */
  childFiles?: string[]
  /**
   * Optional `<scenario>/workspace/` directory whose contents are copied into
   * the temp cwd BEFORE the run — the standard way to seed files the agent
   * operates on (a file to read, edit, or grep). Absent for scenarios that
   * start from an empty workspace.
   */
  workspaceDir?: string
  /**
   * Alternate LIVE config path for the boot (absolute), overriding
   * {@link AgentUnderTest.configPath} for this run. A scenario needing a
   * differently-composed tree (the Code Mode scenarios) ships an overlay
   * whose basename still ends in `cordis.yml`, so the bin's replay swap
   * resolves the sibling `*cordis.snapshot.yml` the same way it does for
   * the default.
   */
  configPath?: string
}

/**
 * Run a scenario end-to-end against a freshly-spawned subprocess. Owns the
 * child and its temp dirs; always tears them down. Returns the captured stdout
 * and (record mode) the harvested session-log path.
 *
 * @param input The scenario's input script (steps + optional permission answers).
 * @param opts The agent to boot, the mode, and the fixture wiring.
 * @returns The captured stdout/stderr, session id, temp cwd, and harvested logs.
 */
export async function runScenario(input: InputScript, opts: RunOptions): Promise<RunResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-snap-cwd-'))
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'acp-snap-sessions-'))
  // Everything past the temp-dir creation runs under a try/finally that always
  // removes both dirs — so a failure in workspace seeding, spawn, or any step
  // never leaks them (the "e2e tests own their resources" rule).
  let child: ChildProcessWithoutNullStreams | undefined
  let sessionId: string | undefined
  let sessionLogs: HarvestedLog[] = []
  const rawBuffers: Buffer[] = []
  const stderrChunks: string[] = []
  try {
    // Seed the workspace if the scenario ships one (a file the agent reads/edits).
    if (opts.workspaceDir !== undefined && existsSync(opts.workspaceDir)) {
      await cp(opts.workspaceDir, cwd, { recursive: true })
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: opts.agent.tsconfigPath,
      DSH_SNAPSHOT: opts.mode,
      DSH_SNAPSHOT_FILE: opts.fixtureFile,
      DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
      DSH_HOME: join(cwd, '.dsh'),
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      ...opts.overrideFile !== undefined ? { DSH_SNAPSHOT_OVERRIDE: opts.overrideFile } : {},
      ...opts.childFiles !== undefined && opts.childFiles.length > 0
        ? { DSH_SNAPSHOT_CHILD_FILES: opts.childFiles.join(delimiter) }
        : {},
    }

    child = spawn(
      process.execPath,
      ['--import', tsxLoader, opts.agent.binScript, '--config', opts.configPath ?? opts.agent.configPath],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => stderrChunks.push(c))

    // Tee the same raw bytes to the golden and SDK client. Decode once at the end so a UTF-8
    // sequence split across stream chunks cannot corrupt the transcript.
    const passthrough = new Readable({ read() {} })
    child.stdout.on('data', (buf: Buffer) => {
      rawBuffers.push(buf)
      passthrough.push(buf)
    })
    child.stdout.on('end', () => passthrough.push(null))

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(passthrough) as ReadableStream<Uint8Array>,
    )
    // Watcher so a step can block until the client OBSERVES a particular
    // session/update — used by promptAndCancel to pin frame order (send cancel
    // only after the streamed agent_message_chunk has arrived, so those frames
    // deterministically precede the cancelled prompt response).
    const updateWaiters: { match: (u: SessionNotification['update']) => boolean; resolve: () => void }[] = []
    const waitForUpdate = (match: (u: SessionNotification['update']) => boolean): Promise<void> =>
      new Promise<void>(resolve => updateWaiters.push({ match, resolve }))

    // Permission answers are consumed FIFO across the whole run; exhaustion
    // falls back to `cancelled` so approval-free scenarios keep the plain stub.
    const permissionQueue = [...input.permissionAnswers ?? []]
    // A callback throw would become only an RPC error the agent could absorb. Record an
    // impossible permission choice here, answer cancelled, and fail the outer scenario.
    let scriptError: Error | undefined
    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate(params: SessionNotification): Promise<void> {
        for (let i = updateWaiters.length - 1; i >= 0; i--) {
          const waiter = updateWaiters[i]
          // The index is always in-bounds (i only decreases; splice removes at
          // i, so lower entries stay valid); the guard satisfies
          // noUncheckedIndexedAccess.
          /* v8 ignore next 1 -- unreachable in-bounds guard, see above */
          if (waiter === undefined) continue
          if (waiter.match(params.update)) {
            updateWaiters.splice(i, 1)
            waiter.resolve()
          }
        }
        return Promise.resolve()
      },
      requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const answer = permissionQueue.shift()
        if (answer === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        const option = params.options.find(o => o.kind === answer.kind)
        if (option === undefined) {
          // The scenario scripted a click the agent never offered — a scenario
          // bug. Captured (last one wins; same bug class either way) and
          // answered `cancelled`; the step loop rejects the run on it.
          scriptError = new Error(
            `snapshot-harness: scripted permission answer ${answer.kind} not among `
            + `the offered options [${params.options.map(o => o.kind).join(', ')}]`,
          )
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        }
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
      },
    })
    const client = new ClientSideConnection(makeClient, stream)

    for (const step of input.steps) {
      await runStep(client, step, cwd, waitForUpdate, () => sessionId, (id) => { sessionId = id })
      // A permission exchange happens while a step's request is in flight, so
      // by the time the step settles any script bug it exposed is captured —
      // fail the run HERE, as a harness error, rather than hoping the agent's
      // reaction to the answer perturbs the transcript.
      if (scriptError !== undefined) throw scriptError
    }
    // Done driving: close stdin so the server disposes gracefully (flushing
    // persistence) and exits. Then await exit so the harvested log is complete.
    child.stdin.end()
    await waitForExit(child)
    // Harvest EVERY persisted log (parent + any subagent children) while the
    // temp dirs still exist, ordered primary-first.
    sessionLogs = await harvestSessionLogs(sessionsRoot)
  } finally {
    // Failure-safe teardown: kill a still-running child and drop the temp dirs
    // even if seeding/spawn/a step/harvest threw, so a flaky run never leaks a
    // process or dir. `child` is undefined only if spawn itself threw.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child)
    }
    await rm(cwd, { recursive: true, force: true })
    await rm(sessionsRoot, { recursive: true, force: true })
  }

  return {
    rawStdout: Buffer.concat(rawBuffers).toString('utf8'),
    stderr: stderrChunks.join(''),
    cwd,
    ...sessionId !== undefined ? { sessionId } : {},
    sessionLogs,
  }
}

/** Drive one input step over the client connection. */
async function runStep(
  client: ClientSideConnection,
  step: InputStep,
  cwd: string,
  waitForUpdate: (match: (u: SessionNotification['update']) => boolean) => Promise<void>,
  getSessionId: () => string | undefined,
  setSessionId: (id: string) => void,
): Promise<void> {
  switch (step.op) {
    case 'initialize':
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: step.terminalOutput === true ? { _meta: { terminal_output: true } } : {},
      })
      return
    case 'newSession': {
      const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
      setSessionId(sessionId)
      return
    }
    case 'newSessionExpectError': {
      // The bridge rejects a session/new that widens the workspace scope (non-empty
      // additionalDirectories / mcpServers — unimplemented).
      await client.newSession({
        cwd,
        mcpServers: [],
        ...step.additionalDirectories !== undefined ? { additionalDirectories: step.additionalDirectories } : {},
      }).then(
        () => { throw new Error('snapshot-harness: expected session/new to be rejected but it succeeded') },
        () => { /* expected: the bridge rejected the unsupported workspace scope */ },
      )
      return
    }
    case 'prompt': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: prompt before newSession')
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
      return
    }
    case 'promptExpectError': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptExpectError before newSession')
      // The model fails this turn (a recorded provider error), so the bridge answers the prompt
      // with a JSON-RPC error and the SDK rejects.
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
        .then(() => { throw new Error('snapshot-harness: expected the prompt to fail but it succeeded') },
          () => { /* expected: the turn failed and the bridge returned an error */ })
      return
    }
    case 'promptAndCancel': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptAndCancel before newSession')
      // A hang fixture never resolves alone. Wait for its streamed chunk before cancellation
      // so updates deterministically precede the cancelled prompt response.
      const promptDone = client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
      await waitForUpdate(u => u.sessionUpdate === 'agent_message_chunk')
      await client.cancel({ sessionId })
      await promptDone
      return
    }
    case 'cancel': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: cancel before newSession')
      await client.cancel({ sessionId })
      return
    }
    case 'setConfigOption': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: setConfigOption before newSession')
      await client.setSessionConfigOption({ sessionId, configId: step.configId, value: step.value })
      return
    }
    case 'setConfigOptionExpectError': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: setConfigOptionExpectError before newSession')
      // The bridge rejects an unknown id / out-of-vocabulary value; the SDK
      // surfaces that as a rejected RPC — swallow it so the run completes and
      // the error frame is captured in the transcript.
      await client.setSessionConfigOption({ sessionId, configId: step.configId, value: step.value }).then(
        () => { throw new Error('snapshot-harness: expected set_config_option to be rejected but it succeeded') },
        () => { /* expected: the bridge rejected the id or value */ },
      )
      return
    }
    default:
      throw new Error(`snapshot-harness: unknown input op ${JSON.stringify(step)}`)
  }
}

/** Resolve once the child process exits (any code/signal). */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  // Race guard: both call sites run within one synchronous frame of
  // stdin.end()/kill(), so the exit event cannot have been delivered yet;
  // kept for any future caller that awaits in between.
  /* v8 ignore next 1 -- unreachable race guard, see above */
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolve => child.once('exit', () => { resolve() }))
}

/**
 * Harvest EVERY persisted `.jsonl` session log under a sessions root, parse each
 * header line, and return them ordered primary-first: the top-level session (no
 * `parentSession`) leads, then each subagent child by ascending `createdAt`.
 *
 * The JSONL backend lays sessions out as `<root>/<cwd-bucket>/<encoded-id>.jsonl`
 * (one bucket per cwd), so a parent and its same-cwd in-process child land in
 * the SAME bucket — collecting all files across all buckets catches both (a
 * first-match short-circuit would silently drop the child). Returns `[]` if no
 * log was produced (a no-session scenario).
 */
async function harvestSessionLogs(root: string): Promise<HarvestedLog[]> {
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(root)
  } catch {
    return []
  }
  const logs: HarvestedLog[] = []
  for (const dir of cwdDirs) {
    const sub = join(root, dir)
    let files: string[]
    try {
      files = await readdir(sub)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const content = await readFile(join(sub, f), 'utf8')
      const firstLine = content.split('\n').find(line => line.trim().length > 0) ?? '{}'
      const header = JSON.parse(firstLine) as { id?: unknown; createdAt?: unknown; parentSession?: unknown }
      logs.push({
        id: typeof header.id === 'string' ? header.id : '',
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
        content,
      })
    }
  }
  // Match replay fixture assignment: primary first, then children by creation time, with id as
  // a deterministic collision tiebreaker.
  logs.sort((a, b) => {
    const ap = a.parentSession === undefined ? 0 : 1
    const bp = b.parentSession === undefined ? 0 : 1
    return ap - bp || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  })
  return logs
}
