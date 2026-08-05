/**
 * @deepseek-ai/dsh-headless — the one-shot headless bundle: the bundle patch
 * (`cordis.patch.yml`) rides over dsh-base + dsh-web-app (the headless
 * session is web-observable while it runs — same composition), and this
 * runner plugin drives one task turn through the in-process API carrier
 * (InProcessApiClient over toFetchHandler(ctx.apiProxy), so the full wire
 * chain — serialization, zod, SSE framing — really runs), prints the final
 * assistant text, and exits (completed → 0, else 1). The task text arrives as
 * launcher-patched config (`dsh --profile headless "task"`).
 * @module @deepseek-ai/dsh-headless
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
// Empty type import carries the httpServer Context merge for the port read below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Services required before the one-shot turn can start. */
export const inject = ['apiProxy', 'httpServer']

/** Plugin config: the task, patched in by the launcher. */
export interface Config {
  /** The prompt text for the single turn. */
  task: string
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
})

/** Outcome of one headless turn: aggregated final text plus the turn-end reason kind. */
interface TurnOutcome {
  text: string
  reason: string
}

/**
 * The process-facing effects of one run, injectable for tests: output
 * streams and the exit request (the launcher wires it to its bounded
 * shutdown controller).
 */
export interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** Host seam: the launcher provides the exit wiring before the tree mounts. */
declare module 'cordis' {
  interface Context {
    /** Process-facing effects for the one-shot headless runner. */
    headlessIo?: HeadlessIo
  }
}

/** Unwrap an RpcResponse or fail loud: business errors print and exit 1. */
async function unwrap<T>(response: RpcResponse<T>, io: HeadlessIo): Promise<T> {
  if (response.result.ok) return response.result.value
  const { code, message } = response.result.error
  io.stderr.write(`dsh: ${code}: ${message}\n`)
  io.exit(1)
  // Exit is asynchronous (bounded tree disposal); park this turn forever so
  // no further request rides a session that is already being torn down.
  return new Promise<never>(() => {})
}

/**
 * Consume mux frames until the task turn ends: anchor on the first turn/start
 * whose trigger kind is 'message' (startup-injected turns are skipped),
 * aggregate text from that turn's assistant/message events (last one wins),
 * finish on its turn/end.
 */
async function consumeUntilTurnEnd(
  frames: AsyncIterable<RpcRequest<MuxFrame>>, sessionId: SessionId, io: HeadlessIo,
): Promise<TurnOutcome> {
  let targetTurn: number | undefined
  let text = ''
  try {
    for await (const frame of frames) {
      const payload = frame.payload
      if (payload.type === 'stream/error') {
        io.stderr.write(`dsh: stream error: ${payload.error.message}\n`)
        return { text, reason: 'error' }
      }
      if (payload.type !== 'session/event' || payload.sessionId !== sessionId) continue
      const event = payload.event
      if (targetTurn === undefined) {
        if (event.type === 'turn/start' && event.data.trigger.kind === 'message') targetTurn = event.data.turn
        continue
      }
      if (event.type === 'assistant/message' && event.data.turn === targetTurn) {
        const joined = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (joined !== '') text = joined
      }
      if (event.type === 'turn/end' && event.data.turn === targetTurn) {
        return { text, reason: event.data.reason.kind }
      }
    }
  } catch (error: unknown) {
    io.stderr.write(`dsh: event stream failed: ${String(error)}\n`)
  }
  return { text, reason: 'error' }
}

/**
 * Run one headless turn for the configured task and request exit
 * (completed → 0, else 1).
 * @param ctx - plugin context carrying apiProxy, httpServer, and the launcher's headlessIo.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const io = ctx.headlessIo
  if (io === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.headlessIo before the tree mounts')
  }
  // Fire-and-forget by design: the turn outlives plugin activation, and every
  // failure path inside ends in io.exit, not a rejection.
  void (async () => {
    // The headless session is web-observable while it runs (same composition).
    io.stderr.write(`dsh: observing at http://127.0.0.1:${String(ctx.httpServer.port)}\n`)
    const api = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
    const created = await unwrap(await api.sessions.create({}), io)
    // Open the stream before prompting so no frame is lost — kept in this
    // order even though in-process delivery has no race, so the code survives
    // a move to a remote HTTP carrier unchanged.
    const abort = new AbortController()
    const frames = api.events.mux({}, abort.signal)
    const done = consumeUntilTurnEnd(frames, created.sessionId, io)
    await unwrap(await api.sessions.prompt({
      sessionId: created.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: config.task }],
    }), io)
    const outcome = await done
    io.stdout.write(outcome.text + '\n')
    abort.abort()
    io.exit(outcome.reason === 'completed' ? 0 : 1)
  })()
}
