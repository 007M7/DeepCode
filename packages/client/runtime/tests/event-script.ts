// Minimal SessionEvent builders for orchestration tests (shape mirrors what the
// host emits; only the fields the object layer reads).
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One text content block (local helper). */
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }]

const at = (seq: number, e: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, ...e }) as unknown as SessionEvent

export const ev = {
  turnStart: (seq: number, turn: number): SessionEvent =>
    at(seq, { type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } }),
  user: (seq: number, body: string): SessionEvent =>
    at(seq, { type: 'user/message', surfaceOp: 'append', data: { content: text(body), source: { kind: 'user' } } }),
  stepStart: (seq: number, turn: number, step = 0): SessionEvent =>
    at(seq, { type: 'step/start', data: { turn, step } }),
  chunkStart: (seq: number, turn: number, step = 0, index = 0): SessionEvent =>
    at(seq, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'block-start', index, blockType: 'text' } } }),
  chunkText: (seq: number, turn: number, piece: string, step = 0, index = 0): SessionEvent =>
    at(seq, { type: 'assistant/chunk', data: { turn, step, chunk: { type: 'text-delta', index, text: piece } } }),
  assistant: (seq: number, turn: number, body: string, step = 0): SessionEvent =>
    at(seq, { type: 'assistant/message', surfaceOp: 'append', data: { turn, step, content: text(body), provenance: { provider: 'fake', model: 'fk-1' } } }),
  toolCall: (seq: number, turn: number, callId: string, name: string, args: string, step = 0): SessionEvent =>
    at(seq, { type: 'tool/call', data: { turn, step, callId, name, arguments: args } }),
  toolResult: (seq: number, turn: number, callId: string, body: string, step = 0): SessionEvent =>
    at(seq, { type: 'tool/result', surfaceOp: 'append', data: { turn, step, callId, content: text(body), isError: false } }),
  codeDispatch: (seq: number, parentCallId: string, n: number, name: string, args: unknown, body: string, isError = false): SessionEvent =>
    at(seq, {
      type: 'tool/code-dispatch',
      data: { parentCallId, subCallId: `${parentCallId}:code:${n}`, name, arguments: args, isError, content: text(body) },
    }),
  stepEnd: (seq: number, turn: number, step = 0): SessionEvent =>
    at(seq, { type: 'step/end', data: { turn, step } }),
  turnEnd: (seq: number, turn: number, reason: 'completed' | 'cancelled' = 'completed'): SessionEvent =>
    at(seq, { type: 'turn/end', data: { turn, reason: { kind: reason } } }),
}

/** One complete plain turn (turn/start → user → step → assistant → turn/end), 6 events from startSeq. */
export function plainTurn(startSeq: number, turn: number, ask: string, answer: string): SessionEvent[] {
  return [
    ev.turnStart(startSeq, turn),
    ev.user(startSeq + 1, ask),
    ev.stepStart(startSeq + 2, turn),
    ev.assistant(startSeq + 3, turn, answer),
    ev.stepEnd(startSeq + 4, turn),
    ev.turnEnd(startSeq + 5, turn),
  ]
}

/** Wrap raw events as view-less history entries (the wire shape history now returns). */
export function entries(events: readonly SessionEvent[]): { event: SessionEvent }[] {
  return events.map(event => ({ event }))
}
