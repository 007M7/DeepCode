/**
 * Shared harness for the ACP snapshot tests. A plain module (NOT a *.spec.ts /
 * *.snapshot.ts) so importing it never re-registers another file's tests.
 *
 * It boots the REAL examples/acp-agent subprocess via the cordis Loader (so the
 * export-shape bug class stays guarded — see docs/postmortem/0001), drives it
 * over real ACP JSON-RPC stdio with a deterministic input script, tees raw
 * stdout (for the golden + a purity check) into an SDK `ClientSideConnection`,
 * and — in record mode — harvests the persisted session JSONL after a graceful
 * shutdown flush. Two pure normalizers turn the captured stdout frames and the
 * session-log events into stable, snapshot-able text.
 *
 * See docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// The dsh-acp-agent bin (the demo:acp entry) and this example's cordis.yml.
// The bin resolves its config-path arg from CWD and, under DSH_SNAPSHOT=replay,
// swaps it for the sibling cordis.snapshot.yml. The child's cwd is a temp dir
// OUTSIDE the repo, so pass the example config's ABSOLUTE path.
const binScript = fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// The repo-root tsconfig: dev/test run UNBUILT and the `@deepseek-ai/dsh-*`
// imports resolve through its `paths` map. The child's cwd is a temp dir
// OUTSIDE the repo, so tsx's upward search would miss it — point tsx at the
// repo tsconfig explicitly (same fix the e2e harness uses). Repo root is four
// levels up from this file (examples/acp-agent/tests).
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * One step of a scenario's deterministic input script (`input.json`). The
 * harness interprets these in order. `newSession` captures the server-issued
 * (random) session id into a `{{sessionId}}` variable that later steps
 * reference, since a committed file cannot know the id in advance.
 *
 * `promptAndCancel` sends a prompt WITHOUT awaiting its response, waits until
 * the client observes the first streamed `agent_message_chunk` (so the emitted
 * frames deterministically precede the cancellation), then cancels the turn —
 * the only way to exercise a cancel deterministically (a plain `prompt` step
 * awaits the response, which a cancel/hang scenario would block on forever).
 */
type InputStep =
  | { op: 'initialize'; terminalOutput?: boolean }
  | { op: 'newSession' }
  | { op: 'newSessionExpectError'; additionalDirectories?: string[] }
  | { op: 'prompt'; text: string }
  | { op: 'promptExpectError'; text: string }
  | { op: 'promptAndCancel'; text: string }
  | { op: 'cancel' }

/** A scenario's `input.json`: an ordered list of input steps. */
export interface InputScript {
  steps: InputStep[]
}

/** The result of running a scenario: raw stdout + the harvested session log. */
export interface RunResult {
  /** Raw stdout bytes (decoded utf8), every newline-delimited JSON-RPC frame. */
  rawStdout: string
  /** stderr (for diagnostics on failure). */
  stderr: string
  /** The session id the server issued (undefined if no session was created). */
  sessionId?: string
  /** The temp cwd the session ran in (the bash workspace). */
  cwd: string
  /** The persisted session log's content, if one was produced. */
  sessionLog?: string
}

interface RunOptions {
  /** `replay` (default, keyless) or `record` (real API, harvests the log). */
  mode: 'replay' | 'record'
  /** The recorded session JSONL fixture path (replay reads it; record writes near it). */
  fixtureFile: string
  /** Optional sidecar override path (replay). */
  overrideFile?: string
  /**
   * Optional `<scenario>/workspace/` directory whose contents are copied into
   * the temp cwd BEFORE the run — the standard way to seed files the agent
   * operates on (a file to read, edit, or grep). Absent for scenarios that
   * start from an empty workspace.
   */
  workspaceDir?: string
}

/**
 * Run a scenario end-to-end against a freshly-spawned subprocess. Owns the
 * child and its temp dirs; always tears them down. Returns the captured stdout
 * and (record mode) the harvested session-log path.
 */
export async function runScenario(input: InputScript, opts: RunOptions): Promise<RunResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-snap-cwd-'))
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'acp-snap-sessions-'))
  // Everything past the temp-dir creation runs under a try/finally that always
  // removes both dirs — so a failure in workspace seeding, spawn, or any step
  // never leaks them (the "e2e tests own their resources" rule).
  let child: ChildProcessWithoutNullStreams | undefined
  let sessionId: string | undefined
  let sessionLog: string | undefined
  const rawBuffers: Buffer[] = []
  const stderrChunks: string[] = []
  try {
    // Seed the workspace if the scenario ships one (a file the agent reads/edits).
    // Copied into the temp cwd so the agent's bash tools see it; the goldens
    // normalize the cwd, so the seeded paths stay stable across runs.
    if (opts.workspaceDir !== undefined && existsSync(opts.workspaceDir)) {
      await cp(opts.workspaceDir, cwd, { recursive: true })
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: repoTsconfig,
      DSH_SNAPSHOT: opts.mode,
      DSH_SNAPSHOT_FILE: opts.fixtureFile,
      DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
      ...opts.overrideFile !== undefined ? { DSH_SNAPSHOT_OVERRIDE: opts.overrideFile } : {},
    }

    child = spawn(
      process.execPath,
      ['--import', tsxLoader, binScript, configPath],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => stderrChunks.push(c))

    // Tee raw stdout: accumulate the bytes for the golden + purity check, and ALSO
    // feed the same bytes to the SDK client through a passthrough. Buffer the raw
    // bytes (not per-chunk utf8 strings) and decode once at the end, so a
    // multibyte sequence split across two 'data' events can't corrupt the golden.
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

    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate(params: SessionNotification): Promise<void> {
        for (let i = updateWaiters.length - 1; i >= 0; i--) {
          const waiter = updateWaiters[i]
          if (waiter !== undefined && waiter.match(params.update)) {
            updateWaiters.splice(i, 1)
            waiter.resolve()
          }
        }
        return Promise.resolve()
      },
      requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    })
    const client = new ClientSideConnection(makeClient, stream)

    for (const step of input.steps) {
      await runStep(client, step, cwd, waitForUpdate, () => sessionId, (id) => { sessionId = id })
    }
    // Done driving: close stdin so the server disposes gracefully (flushing
    // persistence) and exits. Then await exit so the harvested log is complete.
    child.stdin.end()
    await waitForExit(child)
    // Harvest the persisted log (if any) while the temp dirs still exist.
    const sessionLogPath = await findSessionLog(sessionsRoot)
    if (sessionLogPath !== undefined) sessionLog = await readFile(sessionLogPath, 'utf8')
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
    ...sessionLog !== undefined ? { sessionLog } : {},
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
      // The bridge rejects a session/new that widens the workspace scope
      // (non-empty additionalDirectories / mcpServers — unimplemented). The SDK
      // surfaces that as a rejected RPC; swallow it so the run completes and the
      // error frame is captured in the transcript.
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
      // The model fails this turn (a recorded provider error), so the bridge
      // answers the prompt with a JSON-RPC error and the SDK rejects. That
      // rejection IS the expected editor experience — swallow it so the run
      // completes and the stdout transcript (the error frame) is captured.
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: step.text }] })
        .then(() => { throw new Error('snapshot-harness: expected the prompt to fail but it succeeded') },
          () => { /* expected: the turn failed and the bridge returned an error */ })
      return
    }
    case 'promptAndCancel': {
      const sessionId = getSessionId()
      if (sessionId === undefined) throw new Error('snapshot-harness: promptAndCancel before newSession')
      // Dispatch the prompt WITHOUT awaiting (a hang fixture never resolves on
      // its own). To pin frame order deterministically, wait until the client
      // has OBSERVED the hang's streamed agent_message_chunk before cancelling —
      // so those update frames always precede the cancelled prompt response in
      // the transcript (without this, the late chunk and the response race; see
      // the Codex review of commit 5). Then cancel and await the prompt, which
      // the bridge settles as `cancelled` once the abort propagates.
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
    default:
      throw new Error(`snapshot-harness: unknown input op ${JSON.stringify(step)}`)
  }
}

/** Resolve once the child process exits (any code/signal). */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolve => child.once('exit', () => { resolve() }))
}

/** Find the single produced `.jsonl` session log under a sessions root, if any. */
async function findSessionLog(root: string): Promise<string | undefined> {
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(root)
  } catch {
    return undefined
  }
  for (const dir of cwdDirs) {
    const sub = join(root, dir)
    let files: string[]
    try {
      files = await readdir(sub)
    } catch {
      continue
    }
    const jsonl = files.find(f => f.endsWith('.jsonl'))
    if (jsonl !== undefined) return join(sub, jsonl)
  }
  return undefined
}
