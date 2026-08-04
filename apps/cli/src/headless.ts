/**
 * `dsh -p "task"` — headless over the one shared composition: AppCLIEntry
 * boots the same base plus Web overlay as `dsh web` (port 0, so parallel runs never
 * collide), then in-process isomorphic injection (InProcessApiClient over
 * toFetchHandler(ctx.apiProxy), so the full carrier chain — wire
 * serialization, zod, SSE framing — really runs). The printed URL opens the
 * live session in a browser while the task runs. Runs one task turn, prints
 * the final assistant text, exits (completed → 0, else 1).
 */

import { fileURLToPath } from 'node:url'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AppCLIEntry } from './app-cli-entry.ts'
import { createProcessShutdown } from './process-shutdown.ts'

/** Outcome of one headless turn: aggregated final text plus the turn-end reason kind. */
interface TurnOutcome {
  text: string
  reason: string
}

/** Unwrap an RpcResponse or fail loud: business errors print and exit 1 (shutdown first). */
async function unwrap<T>(response: RpcResponse<T>, shutdown: () => Promise<void>): Promise<T> {
  if (response.result.ok) return response.result.value
  const { code, message } = response.result.error
  process.stderr.write(`dsh: ${code}: ${message}\n`)
  await shutdown()
  process.exit(1)
}

/**
 * Consume mux frames until the task turn ends, per the cli-demo runOneShot
 * correlation precedent: anchor on the first turn/start whose trigger kind is
 * 'message' (startup-injected turns are skipped), aggregate text from that
 * turn's assistant/message events (last one wins), finish on its turn/end.
 */
async function consumeUntilTurnEnd(frames: AsyncIterable<RpcRequest<MuxFrame>>, sessionId: SessionId): Promise<TurnOutcome> {
  let targetTurn: number | undefined
  let text = ''
  try {
    for await (const frame of frames) {
      const payload = frame.payload
      if (payload.type === 'stream/error') {
        process.stderr.write(`dsh: stream error: ${payload.error.message}\n`)
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
    process.stderr.write(`dsh: event stream failed: ${String(error)}\n`)
  }
  return { text, reason: 'error' }
}

/**
 * Run one headless turn for `task` and exit (completed → 0, else 1). The task
 * is the non-empty prompt the argument adapter parsed from `-p`/`--prompt`
 * (the adapter rejects an empty task, so no guard is needed here).
 * @param task - the prompt text for the single turn.
 */
export async function runHeadless(task: string): Promise<void> {
  // A missing DEEPSEEK_API_KEY throws here (plugin load is fail-loud, uncaught by design).
  const entry = new AppCLIEntry({
    configPath: fileURLToPath(new URL('../config/base.cordis.yml', import.meta.url)),
    overlayPath: fileURLToPath(new URL('../config/web.cordis.yml', import.meta.url)),
    dev: false,
    watchPersonalConfig: false,
    port: 0,
  })
  const { ctx, port } = await entry.run()
  // Normal completion and signals share one bounded drain. A signal received
  // during that drain escalates immediately instead of becoming a no-op.
  const shutdown = createProcessShutdown(async () => { await ctx.fiber.dispose() })
  process.on('SIGTERM', () => { shutdown.interrupt(143) })
  process.on('SIGINT', () => { shutdown.interrupt(130) })
  // The headless session is web-observable while it runs (same composition).
  process.stderr.write(`dsh: observing at http://127.0.0.1:${String(port)}\n`)
  const api = new InProcessApiClient(toFetchHandler(ctx.apiProxy))

  const created = await unwrap(await api.sessions.create({}), () => shutdown.shutdown(1))

  // Open the stream before prompting so no frame is lost — kept in this order
  // even though in-process delivery has no race, so the code survives a move
  // to a remote HTTP carrier unchanged.
  const abort = new AbortController()
  const frames = api.events.mux({}, abort.signal)
  const done = consumeUntilTurnEnd(frames, created.sessionId)

  await unwrap(await api.sessions.prompt({
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: task }],
  }), () => shutdown.shutdown(1))

  const outcome = await done
  process.stdout.write(outcome.text + '\n')
  abort.abort()
  await shutdown.shutdown(outcome.reason === 'completed' ? 0 : 1)
}
