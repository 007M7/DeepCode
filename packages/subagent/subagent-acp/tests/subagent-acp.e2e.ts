import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as acp from '../src/index.ts'

/**
 * With-key e2e for the ACP subagent backend: the harness drives ITSELF as an ACP
 * server. The backend spawns the real `acp-agent` example as a child PROCESS,
 * speaks ACP to it over stdio, and the child runs the REAL model in its own
 * process to answer a prompt. We verify the child's real answer comes back
 * through the seam — the "talk to our own process" smoke the design called for.
 * Key-gated (self-skips without DEEPSEEK_API_KEY).
 *
 * This is the out-of-process analogue of the in-process spawn e2e: there a
 * parent agent on the same context drove a child; here the child is a separate
 * process reached over ACP, proving the seam generalizes across the boundary.
 */

// The real acp-agent example: its bin + cordis.yml (the live DeepSeek config).
const binScript = fileURLToPath(new URL('../../../ui/acp-agent/src/bin.ts', import.meta.url))
const exampleConfig = fileURLToPath(new URL('../../../../examples/acp-agent/cordis.yml', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

/** The ACP backend ignores the parent, but the seam requires one. */
const fakeParent = { id: 'parent', session: { header: {} } } as unknown as Agent

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('ACP backend with-key e2e (drive our own acp-agent)', () => {
  it('drives the real acp-agent example process to answer a prompt', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-acp-e2e-'))
    ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: ['--import', tsxLoader, binScript, '--config', exampleConfig],
      cwd: workdir,
      permission: 'reject',
      // The child harness needs the key to reach the model; forward it
      // explicitly (buildChildEnv scrubs ambient creds but keeps these extras).
      env: {
        ...process.env.DEEPSEEK_API_KEY !== undefined ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {},
        ...process.env.DEEPSEEK_BASE_URL !== undefined ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {},
        TSX_TSCONFIG_PATH: repoTsconfig,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
    })

    const run = await ctx.subagents.start('acp', {
      prompt: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else. Do not use any tools.' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()

    // The real child process completed its turn and streamed a real answer back
    // across the ACP boundary.
    expect(result.stopReason).toBe('completed')
    const text = result.output.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(text.toUpperCase()).toContain('PONG')
  }, 180_000)

  it('drives the child to do real file work via its own bash tool', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-subagent-acp-e2e-'))
    ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(acp, {
      providerName: 'acp',
      command: process.execPath,
      args: ['--import', tsxLoader, binScript, '--config', exampleConfig],
      cwd: workdir,
      // The child needs to act (run bash), so approve its permission prompts.
      permission: 'allow',
      env: {
        ...process.env.DEEPSEEK_API_KEY !== undefined ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {},
        ...process.env.DEEPSEEK_BASE_URL !== undefined ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {},
        TSX_TSCONFIG_PATH: repoTsconfig,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
    })

    const run = await ctx.subagents.start('acp', {
      prompt: [{ type: 'text', text:
        'Use the bash tool to write the text ACP_CHILD_WAS_HERE into a file named proof.txt '
        + 'in the current directory. Then reply DONE.' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    await run.dispose()

    expect(result.stopReason).toBe('completed')
    // Verify the WORLD: the child process actually wrote the file in its cwd.
    const proof = await readFile(join(workdir, 'proof.txt'), 'utf8')
    expect(proof).toContain('ACP_CHILD_WAS_HERE')
  }, 180_000)
})
