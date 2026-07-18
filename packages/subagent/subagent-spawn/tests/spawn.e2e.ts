import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { spawnHarness, waitForIdle } from './harness.ts'

/**
 * With-key smoke for the in-process spawn backend: a REAL parent agent delegates
 * to a REAL child (via the `subagent` tool → spawn backend) that uses the REAL
 * bash tool to write a file, and we verify the WORLD (the file on disk) — not
 * the agent's self-report. This is the "green units, broken product" guard:
 * mocks prove the plumbing, only a real model proves a parent can actually drive
 * a child to do real work. Key-gated (self-skips without DEEPSEEK_API_KEY).
 */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('spawn backend with-key smoke', () => {
  it('a parent delegates to a child that writes a file on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-spawn-e2e-'))
    ctx = await spawnHarness(workdir)
    const parent = ctx.agentLoop.create(AgentId('e2e-parent'), { provider: 'deepseek', model: 'deepseek-v4-flash' })

    parent.send([{ type: 'text', text:
      'Use the subagent tool to delegate this exact task: "Use the bash tool to write the text '
      + 'SUBAGENT_WAS_HERE into a file named proof.txt in the current directory." '
      + 'After the subagent finishes, tell me it is done.' }])
    await waitForIdle(ctx, parent)

    // Verify the WORLD: the child actually wrote the file.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('SUBAGENT_WAS_HERE')

    // The parent's log records the subagent tool/call + its result (not the
    // child's internal steps).
    const events = [...parent.session.events]
    const subagentCalls = events.filter(e => e.type === 'tool/call' && e.data.name === 'subagent')
    expect(subagentCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
