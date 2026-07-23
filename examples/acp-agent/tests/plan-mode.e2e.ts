import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk'
import {
  launchAcpTestAgent,
  type AgentUnderTest,
  type LaunchedAcpTestAgent,
} from '@deepseek-ai/dsh-acp-snapshot'

/** The shipped ACP leaf's plan mode exercised through its real subprocess entry. */
const AGENT: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

let spawned: LaunchedAcpTestAgent | undefined
let workdir: string | undefined

afterEach(async () => {
  const ownedSpawned = spawned
  const ownedWorkdir = workdir
  spawned = undefined
  workdir = undefined
  try {
    if (ownedSpawned !== undefined) {
      await ownedSpawned.close('SIGKILL').catch((error: unknown) => {
        throw new Error(`plan ACP cleanup failed; child stderr:\n${ownedSpawned.stderr()}`, { cause: error })
      })
    }
  } finally {
    if (ownedWorkdir !== undefined) await rm(ownedWorkdir, { recursive: true, force: true })
  }
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('acp-agent plan mode e2e: approval gates implementation (real model)', () => {
  it('keeps the file unchanged through review, then applies the approved plan', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-plan-e2e-'))
    const proofPath = join(workdir, 'proof.txt')
    await writeFile(proofPath, 'BEFORE\n')

    const reviews: CreateElicitationRequest[] = []
    let contentAtReview: string | undefined
    const createElicitation = async (request: CreateElicitationRequest): Promise<CreateElicitationResponse> => {
      if (request.mode !== 'form' || request.requestedSchema.title !== 'Plan review') return { action: 'cancel' }
      reviews.push(request)
      contentAtReview = await readFile(proofPath, 'utf8')
      return { action: 'accept', content: { choice: 'Approve' } }
    }

    spawned = launchAcpTestAgent({ agent: AGENT, cwd: workdir, createElicitation })
    const { client, updates } = spawned
    const rpc = async <T>(stage: string, operation: Promise<T>): Promise<T> => operation.catch((error: unknown) => {
      throw new Error(`plan ACP ${stage} failed; child stderr:\n${spawned?.stderr() ?? '<unavailable>'}`, { cause: error })
    })
    await rpc('initialize', client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }))
    const created = await rpc('session/new', client.newSession({ cwd: workdir, mcpServers: [] }))
    expect(created.modes?.availableModes.map(mode => mode.id)).toEqual(['default', 'plan'])
    await rpc('session/set_mode', client.setSessionMode({ sessionId: created.sessionId, modeId: 'plan' }))

    const result = await rpc('prompt', client.prompt({
      sessionId: created.sessionId,
      prompt: [{
        type: 'text',
        text: 'Inspect proof.txt and plan the smallest change that replaces its contents with exactly AFTER followed by one newline. Present the complete plan through exit_plan_mode. After I approve it, implement the change with the filesystem tools, verify the exact file contents, and stop. Do not ask questions.',
      }],
    }))

    expect(['end_turn', 'max_tokens']).toContain(result.stopReason)
    expect(reviews).toHaveLength(1)
    expect(contentAtReview).toBe('BEFORE\n')
    expect(await readFile(proofPath, 'utf8')).toBe('AFTER\n')
    expect(updates
      .filter(update => update.sessionUpdate === 'current_mode_update')
      .map(update => update.currentModeId)).toEqual(['plan', 'default'])
  }, 240_000)
})
