/**
 * Scripted fake ACP agent bin for `dsh-acp-snapshot`'s unit specs. Speaks
 * newline-delimited JSON-RPC on stdio like the real `dsh-acp-agent` bin, but
 * every behavior — how prompts settle, whether session/new rejects, which
 * session logs get persisted, what filesystem noise to leave — comes from a
 * `behavior.json` sitting NEXT to the `$DSH_SNAPSHOT_FILE` fixture, so a spec
 * scripts a whole subprocess run from data. The specs launch it through the
 * REAL `runScenario` spawn path (tsx loader, temp cwd, env plumbing), so the
 * harness plumbing is exercised for real; only the agent behind the protocol
 * is scripted.
 *
 * The specs (not the golden tier) own this bin: it asserts nothing, echoes
 * observable facts into `session/update` text chunks (env probe, permission
 * outcome, seeded-workspace listing) for the spec to read off `rawStdout`, and
 * exits 0 on stdin EOF after writing the scripted logs — mirroring the real
 * bin's dispose-flush-exit shape.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

/** One scripted session log: a file path under the sessions root plus its JSONL lines. */
interface ScriptedLog {
  /** Path relative to `$DSH_SNAPSHOT_SESSIONS_ROOT`, e.g. `bucket/a.jsonl` (an empty dir segment is invalid). */
  file: string
  /**
   * The JSONL records. String templates `{{CWD}}` and `{{SID}}` are replaced
   * with the run's real cwd and the ACP session id this bin issued, so a
   * written log carries genuine volatile values for the normalizers to scrub.
   */
  lines: unknown[]
}

/** The whole scripted behavior for one run. Every field defaults to the least surprising choice. */
interface Behavior {
  /** Reject every `session/new` (exercises the expect-error step without extra dirs). */
  rejectNewSession?: boolean
  /** Reject `session/new` only when `additionalDirectories` is non-empty (the real bridge's rule). */
  rejectExtraDirs?: boolean
  /** How `session/prompt` settles: a clean response, a JSON-RPC error, or a hang until `session/cancel`. */
  prompt?: 'respond' | 'error' | 'hang-until-cancel'
  /** Before responding to a prompt, send a `session/request_permission` request and echo its outcome as a chunk. */
  permissionProbe?: boolean
  /** Echo the `DSH_SNAPSHOT_*` env the harness set as a chunk (spec-side env-plumbing assertions). */
  echoEnv?: boolean
  /** Echo the sorted cwd listing as a chunk (spec-side workspace-seeding assertions). */
  echoWorkspace?: boolean
  /** Write a line to stderr on boot (spec-side stderr-capture assertions). */
  stderrNote?: string
  /** Session logs to persist on stdin EOF. */
  logs?: ScriptedLog[]
  /** Leave a stray FILE directly under the sessions root (harvest must skip it). */
  strayRootFile?: boolean
  /** Leave a stray non-`.jsonl` file inside a bucket (harvest must skip it). */
  strayBucketFile?: boolean
  /** Delete the sessions root entirely (harvest must yield no logs). */
  deleteSessionsRoot?: boolean
  /**
   * Vocabulary for `session/set_config_option`: allowed values per config id.
   * A set naming an unknown id or an out-of-vocabulary value rejects (the
   * real bridge's rule); a valid set answers with the complete refreshed
   * option state, `currentValue` updated. Absent: every set rejects.
   */
  configOptions?: Record<string, string[]>
}

const sessionsRoot = process.env.DSH_SNAPSHOT_SESSIONS_ROOT ?? ''
const fixtureFile = process.env.DSH_SNAPSHOT_FILE ?? ''
const behavior: Behavior = fixtureFile === ''
  ? {}
  : JSON.parse(readFileSync(join(dirname(fixtureFile), 'behavior.json'), 'utf8')) as Behavior

if (behavior.stderrNote !== undefined) process.stderr.write(`${behavior.stderrNote}\n`)

let nextOutboundId = 1000
let sessionId = ''
/**
 * The cwd the client passed to `session/new` — used verbatim for `{{CWD}}`
 * substitution, mirroring the real bin (whose persisted header carries the
 * session cwd as given, NOT `process.cwd()`, which the OS realpaths — on
 * macOS `/var/folders/…` vs `/private/var/folders/…`).
 */
let sessionCwd = ''
/** The parked prompt request id while `hang-until-cancel` waits for the cancel notification. */
let parkedPromptId: number | string | null = null
/** Resolvers for permission-probe responses, keyed by outbound request id. */
const pendingPermission = new Map<number, (outcome: unknown) => void>()
/** Per-run `session/set_config_option` state: config id → current value (first vocabulary entry until set). */
const currentConfig: Record<string, string> = {}

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}

function respond(id: number | string, result: unknown): void {
  send({ id, result })
}

function respondError(id: number | string, message: string): void {
  send({ id, error: { code: -32603, message } })
}

function chunk(text: string): void {
  send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
}

/** Substitute the `{{CWD}}`/`{{SID}}` templates through a scripted log record. */
function instantiate(value: unknown): unknown {
  if (typeof value === 'string') return value.split('{{CWD}}').join(sessionCwd).split('{{SID}}').join(sessionId)
  if (Array.isArray(value)) return value.map(instantiate)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = instantiate(v)
    return out
  }
  return value
}

async function handlePrompt(id: number | string): Promise<void> {
  if ((behavior.prompt ?? 'respond') === 'hang-until-cancel') {
    // A thought chunk BEFORE any message chunk: a promptAndCancel waiter
    // watches for agent_message_chunk, so this exercises its non-matching
    // update path while the waiter is armed.
    send({
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'mulling' } } },
    })
  }
  chunk('thinking about it')
  if (behavior.echoEnv === true) {
    chunk(`env:${JSON.stringify({
      mode: process.env.DSH_SNAPSHOT,
      override: process.env.DSH_SNAPSHOT_OVERRIDE ?? null,
      childFiles: process.env.DSH_SNAPSHOT_CHILD_FILES ?? null,
    })}`)
  }
  if (behavior.echoWorkspace === true) {
    chunk(`workspace:${readdirSync(process.cwd()).sort().join(',')}`)
  }
  if (behavior.permissionProbe === true) {
    const requestId = nextOutboundId++
    const outcome = await new Promise<unknown>((resolve) => {
      pendingPermission.set(requestId, resolve)
      send({
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'call_fake_1', title: 'fake tool', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })
    })
    chunk(`permission:${JSON.stringify(outcome)}`)
  }
  switch (behavior.prompt ?? 'respond') {
    case 'respond':
      respond(id, { stopReason: 'end_turn' })
      return
    case 'error':
      respondError(id, 'model exploded')
      return
    case 'hang-until-cancel':
      parkedPromptId = id
      return
  }
}

function handleFrame(frame: Record<string, unknown>): void {
  const id = frame.id as number | string | undefined
  const method = frame.method as string | undefined
  const params = (frame.params ?? {}) as Record<string, unknown>
  // A response to one of OUR outbound requests (the permission probe).
  if (method === undefined && id !== undefined && typeof id === 'number' && pendingPermission.has(id)) {
    const resolve = pendingPermission.get(id) as (outcome: unknown) => void
    pendingPermission.delete(id)
    resolve((frame.result as { outcome?: unknown } | undefined)?.outcome ?? null)
    return
  }
  switch (method) {
    case 'initialize':
      respond(id as number | string, { protocolVersion: 1, agentCapabilities: { loadSession: false } })
      return
    case 'session/new': {
      const extra = params.additionalDirectories as unknown[] | undefined
      if (behavior.rejectNewSession === true || (behavior.rejectExtraDirs === true && extra !== undefined && extra.length > 0)) {
        respondError(id as number | string, 'unsupported workspace scope')
        return
      }
      sessionId = randomUUID()
      sessionCwd = typeof params.cwd === 'string' ? params.cwd : process.cwd()
      respond(id as number | string, { sessionId })
      return
    }
    case 'session/prompt':
      void handlePrompt(id as number | string)
      return
    case 'session/set_config_option': {
      const vocabulary = behavior.configOptions
      const configId = params.configId as string
      const value = params.value as string
      const values = vocabulary?.[configId]
      if (values === undefined) {
        respondError(id as number | string, `unknown config option ${configId}`)
        return
      }
      if (!values.includes(value)) {
        respondError(id as number | string, `unknown ${configId} value ${value}`)
        return
      }
      currentConfig[configId] = value
      // The real bridge's contract: every set answers with the COMPLETE
      // refreshed option state, not just the changed entry.
      respond(id as number | string, {
        configOptions: Object.entries(vocabulary as Record<string, string[]>).map(([cid, vs]) => ({
          id: cid,
          type: 'select',
          currentValue: currentConfig[cid] ?? vs[0],
          options: vs.map(v => ({ value: v, name: v })),
        })),
      })
      return
    }
    case 'session/cancel':
      if (parkedPromptId !== null) {
        const parked = parkedPromptId
        parkedPromptId = null
        respond(parked, { stopReason: 'cancelled' })
      }
      return
    default:
      // Unknown method: a notification is ignored; a request gets an error so
      // the SDK never waits forever on a frame this fake doesn't model.
      if (id !== undefined) respondError(id, `unhandled method ${String(method)}`)
  }
}

function flushLogsAndExit(): void {
  for (const log of behavior.logs ?? []) {
    const target = join(sessionsRoot, log.file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, log.lines.map(l => JSON.stringify(instantiate(l))).join('\n') + '\n')
  }
  if (behavior.strayRootFile === true) writeFileSync(join(sessionsRoot, 'stray.txt'), 'not a bucket\n')
  if (behavior.strayBucketFile === true) {
    mkdirSync(join(sessionsRoot, 'bucket-noise'), { recursive: true })
    writeFileSync(join(sessionsRoot, 'bucket-noise', 'notes.txt'), 'not a session log\n')
  }
  if (behavior.deleteSessionsRoot === true) rmSync(sessionsRoot, { recursive: true, force: true })
  process.exit(0)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim().length === 0) return
  handleFrame(JSON.parse(line) as Record<string, unknown>)
})
rl.on('close', () => { flushLogsAndExit() })
