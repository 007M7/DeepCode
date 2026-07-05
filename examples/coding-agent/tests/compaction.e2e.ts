import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { codingHarness, finalText, SYSTEM_PROMPT, waitForIdle } from './harness.ts'

/**
 * The compaction smoke test: a real model runs a multi-step bash task with a
 * deliberately tiny context window, so the auto-compaction listener fires
 * MID-SESSION and summarizes the older history into a checkpoint. This is the
 * first end-to-end exercise of the compaction seam (it is wired nowhere else),
 * and the runaway-survival regression net — it proves a session that grows past
 * the window keeps running rather than overflowing. Key-gated.
 *
 * Verifies the WORLD, not the agent's self-report: a compact/start…end pair
 * landed in the real session log, the surface actually shrank (a replace node
 * exists and shadowed older nodes), and the agent still produced a final answer
 * after compaction (so the summarized history did not break the conversation).
 *
 * FIXME(compaction-snapshot): this key-gated e2e is the ONLY coverage of runaway
 * compaction — there is no keyless full-transcript snapshot of it. dsh-llm-replay
 * reconstructs one model call per (turn, step) from `assistant/chunk` events, but
 * `summarize()` assembles its stream into a local BlockAssembler and appends no
 * `assistant/chunk`, so the interleaved summarization call is unreplayable. A
 * snapshot needs replay-harness work to serve that call; deferred as a follow-up.
 */

let workdir: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('compaction: a long session compacts mid-flight and keeps running', () => {
  it('summarizes older history into a checkpoint without breaking the task', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-compaction-'))
    // A handful of files for the model to read, so multiple bash steps
    // accumulate surface nodes (tool calls + results) and grow the history past
    // the (deliberately tiny) window.
    for (let i = 1; i <= 4; i++) {
      await writeFile(join(workdir, `file${i}.txt`), `This is file number ${i}. `.repeat(50))
    }

    // Tiny window so a couple of steps crosses the threshold. The generation
    // cap is deliberately larger than the final checkpoint because
    // reasoning-capable APIs count reasoning tokens against the provider output
    // budget even though those blocks are stripped before the checkpoint is
    // stored.
    ctx = await codingHarness(workdir, {
      persona: SYSTEM_PROMPT,
      compact: {
        contextWindow: 2000,
        thresholdRatio: 0.5,
        retainTokens: 400,
        summarizationModel: '',
        maxTokens: 1024,
        compactionRetries: 1,
      },
      persistenceRoot: join(workdir, '.sessions'),
    })
    const agent = ctx.agentLoop.create(AgentId('e2e-compaction'), { model: 'deepseek-v4-flash' })

    agent.send([{
      type: 'text',
      text: 'Read file1.txt, file2.txt, file3.txt, and file4.txt one at a '
        + 'time using cat (a separate bash command for each). After reading all four, tell me how '
        + 'many files you read and the number mentioned in file1.txt.',
    }])
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]

    // A compaction ran: the start…end bracket landed in the real log.
    const starts = events.filter(e => e.type === 'compact/start')
    const ends = events.filter(e => e.type === 'compact/end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBe(starts.length) // every start was released

    // It succeeded at least once: a compact/summary provenance event and a
    // replace-op user/message (the surface mutation) both landed.
    const summaries = events.filter(e => e.type === 'compact/summary')
    expect(summaries.length).toBeGreaterThan(0)
    const replaceNode = events.find((e) => {
      const se = e as unknown as { type: string; surfaceOp?: unknown }
      return se.type === 'user/message' && typeof se.surfaceOp === 'object' && se.surfaceOp !== null
    })
    expect(replaceNode).toBeDefined()

    // The summary shadowed real older nodes (the surface shrank vs. the raw
    // message-producing event count).
    const summaryData = summaries[0]!.data as { shadowedSeqs: number[] }
    expect(summaryData.shadowedSeqs.length).toBeGreaterThan(0)

    // The conversation survived compaction: the agent produced a final answer
    // that reflects the work (it read four files).
    const answer = finalText(events).toLowerCase()
    expect(answer.length).toBeGreaterThan(0)
    expect(answer).toMatch(/\b(4|four)\b/)
  }, 240_000)
})
