import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { buildChildEnv } from '@deepseek-ai/dsh-subagent-subprocess'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as acp from '../src/index.ts'
import { acpStopReason, acpContentText, DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, startAcpRun, toAcpPrompt, type AcpRunSpec } from '../src/run.ts'

/**
 * Keyless integration tests for the ACP subagent backend. Each spawns a REAL
 * subprocess — the scripted mock ACP server (tests/mock-acp-server.ts) — and
 * drives it through the REAL backend over real ACP JSON-RPC stdio, so the
 * connection setup, the client callbacks, the prompt round-trip, the stop-reason
 * mapping, cancellation, and quiescent disposal are all exercised end to end.
 * No model, no key.
 */

const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))

/** A throwaway parent Agent — the ACP backend ignores it, but the seam requires one. */
const fakeParent = { id: 'parent', session: { header: {} } } as unknown as Agent

function request(text = 'p', signal = new AbortController().signal) {
  return { prompt: [{ type: 'text' as const, text }], parent: fakeParent, signal }
}

interface SetupEnv {
  /** Mock-server scripting env: MOCK_TEXT / MOCK_STOP / MOCK_HANG / MOCK_PERMISSION. */
  [key: string]: string
}

/**
 * Mount the ACP backend pointed at the mock server, scripted by `mockEnv`.
 * `permission` selects the backend's auto-answer policy.
 */
async function setup(mockEnv: SetupEnv = {}, permission: 'allow' | 'reject' = 'reject') {
  const ctx = new Context()
  await ctx.plugin(SubagentService)
  await ctx.plugin(acp, {
    providerName: 'acp',
    command: process.execPath,
    args: [mockServer],
    permission,
    env: mockEnv,
  })
  return ctx
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

/**
 * Poll until `file` exists (the mock touches it once its prompt is in flight),
 * so a cancel test waits on a CONDITION rather than an arbitrary timeout — the
 * subprocess cold-start is variable, and a fixed sleep both flakes and
 * slows the suite. Fails loud if the child never signals readiness.
 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`mock child never became ready (${file})`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('acpStopReason', () => {
  it('maps each ACP stop reason to the harness vocabulary', () => {
    expect(acpStopReason('end_turn')).toBe('completed')
    expect(acpStopReason('max_tokens')).toBe('max-tokens')
    expect(acpStopReason('refusal')).toBe('refusal')
    expect(acpStopReason('cancelled')).toBe('aborted')
    expect(acpStopReason('max_turn_requests')).toBe('error')
  })

  it('treats an unknown terminal reason as an error', () => {
    expect(acpStopReason('something-new' as never)).toBe('error')
  })
})

describe('acpContentText / toAcpPrompt', () => {
  it('extracts text from a text content block, empty for non-text', () => {
    expect(acpContentText({ type: 'text', text: 'hi' })).toBe('hi')
    // A non-text ACP content block (e.g. an image) contributes no text.
    expect(acpContentText({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe('')
  })

  it('keeps text prompt blocks and drops non-text ones', () => {
    expect(toAcpPrompt([{ type: 'text', text: 'a' }])).toEqual([{ type: 'text', text: 'a' }])
    // A non-text harness block (e.g. reasoning) is dropped from the ACP prompt.
    expect(toAcpPrompt([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'think' }]))
      .toEqual([{ type: 'text', text: 'a' }])
  })
})

describe('buildChildEnv', () => {
  it('drops credential-shaped ambient vars but keeps the explicit extras', () => {
    process.env.DSH_ACP_TEST_SECRET_TOKEN = 'leak-me'
    try {
      const env = buildChildEnv({ DEEPSEEK_API_KEY: 'explicit' })
      // The credential-shaped ambient var is scrubbed.
      expect(env.DSH_ACP_TEST_SECRET_TOKEN).toBeUndefined()
      // The explicitly-supplied key survives (an opt-in for the child's creds).
      expect(env.DEEPSEEK_API_KEY).toBe('explicit')
      // A normal ambient var is forwarded.
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      delete process.env.DSH_ACP_TEST_SECRET_TOKEN
    }
  })
})

describe('dsh-subagent-acp', () => {
  it('drives child processes with parent-unique run ids and returns streamed output', async () => {
    const ctx = await setup({ MOCK_TEXT: 'hello from acp child', MOCK_STOP: 'end_turn', MOCK_SESSION_ID: 'acp-child-session' })
    const run = await ctx.subagents.start('acp', request('do X'))
    expect(run.id).not.toBe('acp-child-session')
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('hello from acp child')
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal

    const nextRun = await ctx.subagents.start('acp', request('do X again'))
    expect(nextRun.id).not.toBe(run.id)
    expect(nextRun.id).not.toBe('acp-child-session')
    await nextRun.result
    await nextRun.dispose()
  })

  it('maps a max_tokens stop reason', async () => {
    const ctx = await setup({ MOCK_TEXT: 'cut off', MOCK_STOP: 'max_tokens' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    await run.dispose()
  })

  it('maps a refusal stop reason', async () => {
    const ctx = await setup({ MOCK_TEXT: '', MOCK_STOP: 'refusal' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('refusal')
    await run.dispose()
  })

  it('aborting the required signal cancels a running child', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-cancel-'))
    const readyFile = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_READY_FILE: readyFile })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      // Wait until the child's prompt is in flight (condition, not a sleep),
      // then cancel — so we exercise the mid-run session/cancel path.
      await waitForFile(readyFile)
      controller.abort('test')
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects WITHOUT spawning the child when the signal is already aborted', async () => {
    // A pre-aborted request must not even launch the configured binary. Point
    // the command at one that would create a sentinel file if it ever ran, and
    // assert the sentinel never appears.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-preabort-'))
    const sentinel = join(tmp, 'spawned')
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(startAcpRun(
        request('p', controller.signal),
        // `touch <sentinel>` — runs only if the process is actually spawned.
        { command: 'touch', args: [sentinel], cwd: tmp, permission: 'reject', env: {}, disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS, disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS },
      )).rejects.toThrow('aborted before the ACP child started')
      // The binary was never launched — no sentinel.
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reaps a child whose session/new response omits the session id', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-malformed-session-'))
    const flushed = join(tmp, 'flushed')
    try {
      await expect(startAcpRun(request(), {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: {
          MOCK_MISSING_SESSION_ID: '1',
          MOCK_FLUSH_ON_EOF: flushed,
          MOCK_FLUSH_DELAY_MS: '20',
        },
        disposeEofGraceMs: 1000,
        disposeGraceMs: 100,
      })).rejects.toThrow('ACP child published without a session id')
      // Startup rejects only after its private child reaches quiescence. The
      // marker proves rollback closed stdin and allowed the child's EOF flush.
      expect(existsSync(flushed)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dispose escalates SIGTERM → SIGKILL for a child that traps SIGTERM (bounded quiescence)', async () => {
    // The child traps SIGTERM and keeps its event loop alive, so a graceful
    // term alone would hang dispose forever. With a short grace, dispose must
    // escalate to SIGKILL and return once the process is actually gone.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-trap-'))
    const ready = join(tmp, 'trap-armed')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_TRAP_SIGTERM: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready },
        // Short on BOTH tiers: the trap ignores EOF and SIGTERM, so dispose must
        // burn the EOF window, then the SIGTERM window, then SIGKILL — keep each
        // small so the whole ladder finishes well within the 4000ms bound.
        disposeEofGraceMs: 150,
        disposeGraceMs: 150,
      }
      const run = await startAcpRun(request(), spec)
      // Wait until the child has BOOTED AND ARMED THE TRAP (a condition, not a
      // sleep) — otherwise SIGTERM races the trap install and the default handler
      // terminates the child, never exercising the escalation.
      await waitForFile(ready)
      // Don't await result (the child hangs). Dispose must still return promptly
      // via the SIGKILL escalation — bound it so a regression (no escalation)
      // fails loud instead of hanging the suite.
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return — no SIGKILL escalation')) }, 4000) }),
      ])).resolves.toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dispose gives the child an EOF window that outlasts the SIGTERM grace (graceful flush)', async () => {
    // The real acp-agent flushes ASYNCHRONOUSLY on stdin EOF (its bridge tears
    // down on connection close, NOT on a signal) — and it has no SIGTERM handler.
    // Its EOF teardown can itself await a signal-trapping grandchild (a bash
    // subprocess in its own SIGTERM→SIGKILL grace) plus a flush, so the EOF window
    // must be a SEPARATE, WIDER grace than the SIGTERM tier — not the same value.
    // The mock models a flush that takes LONGER than the SIGTERM grace but well
    // under the EOF grace: it lands only because tier 1 waits eofGraceMs, not
    // graceMs. (If dispose reused the small SIGTERM grace for the EOF wait — the
    // round-2 bug — SIGTERM would fire mid-flush and the marker would be missing.)
    const tmp = mkdtempSync(join(tmpdir(), 'acp-eof-'))
    const ready = join(tmp, 'ready')
    const flushed = join(tmp, 'flushed')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        // MOCK_HANG so the prompt never resolves on its own — we tear down a live
        // child. The flush beat (400ms) outlasts the 50ms SIGTERM grace but fits
        // the 2000ms EOF grace; the marker lands iff the EOF tier honored its own
        // wider grace.
        env: {
          MOCK_HANG: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready,
          MOCK_FLUSH_ON_EOF: flushed, MOCK_FLUSH_DELAY_MS: '400',
        },
        disposeEofGraceMs: 2000,
        disposeGraceMs: 50,
      }
      const run = await startAcpRun(request(), spec)
      // Wait until the child is fully booted with its prompt in flight (its ACP
      // stdin reader is attached), so dispose's stdin EOF reaches a live child.
      await waitForFile(ready)
      await run.dispose()
      // dispose returned via the natural-exit tier — the EOF-driven flush landed
      // despite taking longer than the SIGTERM grace.
      expect(existsSync(flushed)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('escalates to SIGTERM for a child that ignores EOF but is not SIGTERM-trapping', async () => {
    // A child that keeps its loop alive past stdin EOF (so the graceful window
    // times out) but exits cooperatively on SIGTERM must die on the SIGTERM tier
    // — dispose returns there, never reaching the SIGKILL tier. The child touches
    // a SIGTERM marker from its signal handler: SIGKILL is uncatchable, so if
    // dispose had skipped the middle rung (EOF→SIGKILL) the handler would never
    // run and the marker would be absent — making this a GENUINE middle-tier guard.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-ignore-eof-'))
    const ready = join(tmp, 'ready')
    const sigterm = join(tmp, 'sigterm')
    try {
      const spec: AcpRunSpec = {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: {
          MOCK_HANG: '1', MOCK_IGNORE_EOF: '1', MOCK_TEXT: 'x',
          MOCK_READY_FILE: ready, MOCK_SIGTERM_FILE: sigterm,
        },
        // Tiny EOF grace so the ignored-EOF window elapses fast, then SIGTERM.
        disposeEofGraceMs: 150,
        disposeGraceMs: 2000,
      }
      const run = await startAcpRun(request(), spec)
      await waitForFile(ready)
      // Bound it so a hang fails loud rather than stalling the suite.
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return')) }, 5000) }),
      ])).resolves.toBeUndefined()
      // The child caught SIGTERM and exited — proof the middle rung fired (not a
      // jump straight to the uncatchable SIGKILL).
      expect(existsSync(sigterm)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects after cleanup when the signal aborts during newSession', async () => {
    // Gate the child at newSession: it signals `ready` and blocks until `go`.
    // We cancel WHILE newSession is pending (sessionId still undefined, so the
    // backend cannot send session/cancel) — the `cancelled` flag alone must
    // settle the run aborted after newSession resolves, never issuing the prompt.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-early-'))
    const ready = join(tmp, 'ready')
    const go = join(tmp, 'go')
    try {
      const ctx = await setup({ MOCK_NEWSESSION_READY: ready, MOCK_NEWSESSION_GO: go, MOCK_TEXT: 'should not run' })
      const controller = new AbortController()
      const starting = ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready) // newSession is now in flight, sessionId undefined
      controller.abort('early')
      writeFileSync(go, 'go') // let newSession resolve
      await expect(starting).rejects.toThrow('aborted before the ACP child started')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('bridges the request signal to a session/cancel mid-run', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'acp-signal-'))
    const readyFile = join(tmp, 'ready')
    try {
      const controller = new AbortController()
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_READY_FILE: readyFile })
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(readyFile)
      controller.abort()
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('auto-rejects a permission prompt by default (child settles cancelled→aborted)', async () => {
    const ctx = await setup({ MOCK_TEXT: 'x', MOCK_PERMISSION: '1' }, 'reject')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    // The child asked permission, the backend rejected, the child returned cancelled.
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('auto-approves a permission prompt under the allow policy', async () => {
    const ctx = await setup({ MOCK_TEXT: 'approved answer', MOCK_PERMISSION: '1', MOCK_STOP: 'end_turn' }, 'allow')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('approved answer')
    await run.dispose()
  })

  it('falls back to cancelled under the allow policy when the child offers no allow option', async () => {
    // The child asks permission but offers ONLY reject-shaped options, so an
    // allow-policy client finds nothing to select and must answer cancelled.
    const ctx = await setup({ MOCK_PERMISSION: '1', MOCK_NO_ALLOW: '1' }, 'allow')
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  })

  it('consumes a non-message update (a thought) without adding it to the output', async () => {
    // The child streams an agent_thought_chunk before its answer; the backend
    // must consume it but NOT include it in the result output.
    const ctx = await setup({ MOCK_THOUGHT: '1', MOCK_TEXT: 'final answer', MOCK_STOP: 'end_turn' })
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    // Only the message text, NOT the thought.
    expect(text(result.output)).toBe('final answer')
    await run.dispose()
  })

  it('rejects a spawn failure after provider-owned cleanup', async () => {
    await expect(startAcpRun(
      request(),
      { command: '/nonexistent/acp-agent-binary', args: [], cwd: process.cwd(), permission: 'reject', env: {}, disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS, disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS },
    )).rejects.toThrow()
  })

  it('plugin-config dispose graces reach the run (SIGKILL escalation through the provider)', async () => {
    // Same trap scenario as the direct startAcpRun escalation test, but the
    // graces arrive via the PLUGIN CONFIG through the registered provider — so a
    // regression that stops threading config into AcpRunSpec (falling back to
    // the 6s/3s defaults) blows past the 4000ms bound and fails loud.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-cfg-trap-'))
    const ready = join(tmp, 'trap-armed')
    try {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      await ctx.plugin(acp, {
        providerName: 'acp',
        command: process.execPath,
        args: [mockServer],
        permission: 'reject',
        env: { MOCK_TRAP_SIGTERM: '1', MOCK_TEXT: 'x', MOCK_READY_FILE: ready },
        disposeEofGraceMs: 150,
        disposeGraceMs: 150,
      })
      const run = await ctx.subagents.start('acp', request())
      await waitForFile(ready)
      await expect(Promise.race([
        run.dispose(),
        new Promise((_r, reject) => { setTimeout(() => { reject(new Error('dispose did not return — config graces not threaded to the run')) }, 4000) }),
      ])).resolves.toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a non-positive dispose grace at load', async () => {
    for (const bad of [{ disposeEofGraceMs: 0 }, { disposeGraceMs: -1 }, { disposeEofGraceMs: Number.NaN }]) {
      const ctx = new Context()
      await ctx.plugin(SubagentService)
      await expect(ctx.plugin(acp, { providerName: 'acp', command: 'true', args: [], permission: 'reject', env: {}, ...bad }))
        .rejects.toThrow(/subagent-acp: dispose(?:Eof)?GraceMs must be a positive finite number/)
      await ctx.fiber.dispose()
    }
  })

  it('rejects a startup failure via the provider load path', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: '/nonexistent/acp-agent-binary',
      args: [],
      permission: 'reject',
      env: {},
    })
    await expect(ctx.subagents.start('acp', request())).rejects.toThrow()
  })

  it('reports a flattened child failure through onError (preserved, not silently lost)', async () => {
    // The seam forbids `result` rejecting, so a child-level failure is flattened
    // to a stop reason — onError must still surface the original error so a real
    // fault is logged, not swallowed. The child exits after its session is
    // published but while prompt is in flight.
    const errors: { message: string; stopReason: string }[] = []
    const run = await startAcpRun(
      request(),
      {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_CRASH_ON_PROMPT: '1' },
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        onError: (error, stopReason) => { errors.push({ message: error.message, stopReason }) },
      },
    )
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.stopReason).toBe('error')
    expect(errors[0]!.message.length).toBeGreaterThan(0)
    await run.dispose()
  })

  it('logs a flattened child failure through the registered provider', async () => {
    const ctx = await setup({ MOCK_CRASH_ON_PROMPT: '1' })
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const run = await ctx.subagents.start('acp', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(warnings).toEqual([
      expect.stringContaining('subagent-acp "acp": child run failed (error):'),
    ])
    await run.dispose()
  })

  it('resolves error (never rejects) even when the onError sink itself throws', async () => {
    // onError is a caller-supplied callback boundary: its own exception must be
    // contained, or it would reject `result` and break the seam's "result never
    // rejects" contract that the flattening above exists to uphold.
    const run = await startAcpRun(
      request(),
      {
        command: process.execPath,
        args: [mockServer],
        cwd: process.cwd(),
        permission: 'reject',
        env: { MOCK_CRASH_ON_PROMPT: '1' },
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        onError: () => { throw new Error('sink boom') },
      },
    )
    const result = await run.result
    expect(result.stopReason).toBe('error')
    await run.dispose()
  })

  it('settles aborted when the child crashes (tears the pipe) AFTER a cancel', async () => {
    // The child hangs, we cancel, and instead of answering the child exits hard
    // — the pending prompt RPC rejects. With a cancel already requested, the
    // backend's catch path must settle `aborted` (the failure is the cancel
    // surfacing as a torn pipe), not `error`.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-crash-'))
    const ready = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_CRASH_ON_CANCEL: '1', MOCK_READY_FILE: ready })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready)
      controller.abort('crash it')
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('settles aborted on signal even when the child IGNORES session/cancel', async () => {
    // The signal contract requires `result` to settle `aborted`. A child that hangs
    // its prompt AND ignores session/cancel must not wedge the parent — the
    // backend's own cancel-settle path resolves `aborted` without the child's
    // cooperation, and dispose() still reaps the process.
    const tmp = mkdtempSync(join(tmpdir(), 'acp-ignorecancel-'))
    const ready = join(tmp, 'ready')
    try {
      const ctx = await setup({ MOCK_TEXT: 'partial', MOCK_HANG: '1', MOCK_IGNORE_CANCEL: '1', MOCK_READY_FILE: ready })
      const controller = new AbortController()
      const run = await ctx.subagents.start('acp', request('p', controller.signal))
      await waitForFile(ready)
      controller.abort('test')
      // Bound it: a regression (cancel only notifies the child, which ignores it)
      // would hang result forever — fail loud instead of stalling the suite.
      const result = await Promise.race([
        run.result,
        new Promise<never>((_r, reject) => { setTimeout(() => { reject(new Error('result did not settle on cancel — backend waited on the child')) }, 4000) }),
      ])
      expect(result.stopReason).toBe('aborted')
      await run.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('advertises no start-time capabilities (out-of-process child)', async () => {
    const ctx = await setup()
    const provider = ctx.subagents.getProvider('acp')!
    expect(provider.capabilities).toEqual({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(acp, { providerName: 'acp', command: 'x', args: [], permission: 'reject', env: {} })
    expect(ctx.subagents.list()).toEqual(['acp'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in acp).toBe(false)
    expect(acp.name).toBe('subagent-acp')
    expect(acp.inject).toEqual(['subagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(acp) as Record<string, unknown>
    expect(unwrapped).toBe(acp)
    expect(unwrapped.name).toBe('subagent-acp')
    expect(typeof unwrapped.apply).toBe('function')
  })
})
