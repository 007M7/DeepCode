import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  launchAcpTestAgent,
  type AgentUnderTest,
  type LaunchedAcpTestAgent,
} from '@deepseek-ai/dsh-acp-snapshot'

/**
 * With-key e2e: the Claude Code hook bridge running against the REAL acp-agent
 * subprocess and the REAL model. The example `cordis.yml` loads `dsh-hooks-claude`
 * with a PROCESS-LEVEL `configPath` of `./hooks.json`, resolved once at load
 * against the ACP server's launch cwd (NOT per-session); this test sets that
 * launch cwd to the temp workspace and writes a `hooks.json` there with a
 * PreToolUse hook that BLOCKS every bash command, then asks the live model to
 * write a file — and verifies the WORLD (the file never appears on disk),
 * proving the hook actually intercepted execution rather than the agent merely
 * claiming it couldn't. (The hook itself then runs in the session cwd.)
 * Key-gated; owns and disposes its subprocess.
 *
 * A keyless companion lives in acp.e2e.ts (stdout purity + session/new); the
 * full hook-fires-end-to-end transcript is the keyless `hook-cc-promptsubmit-block`
 * snapshot scenario. This one closes the "green plumbing, broken product" gap:
 * only a real model deciding to call bash exercises the PreToolUse seam live.
 */

const AGENT: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../packages/ui/acp-agent/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

let spawned: LaunchedAcpTestAgent | undefined
let workdir: string | undefined

afterEach(async () => {
  try {
    await spawned?.close('SIGKILL')
  } finally {
    spawned = undefined
    try {
      if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
    } finally {
      workdir = undefined
    }
  }
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('acp-agent e2e: a PreToolUse hook blocks bash (real model)', () => {
  it('denies every bash command, so the requested file is never written (verified on disk)', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'acp-hooks-e2e-'))
    // A PreToolUse hook that blocks EVERY tool (exit 2, no matcher = match-all).
    // The session cwd is `workdir`, and the bridge resolves `./hooks.json` from
    // the process cwd (the launch dir = workdir), so this is the config it loads.
    await writeFile(join(workdir, 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo "bash blocked by policy" >&2; exit 2' }] }] },
    }))

    spawned = launchAcpTestAgent({
      agent: AGENT,
      cwd: workdir,
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
    })
    const { client, updates } = spawned

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: workdir, mcpServers: [] })

    const res = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Use the bash tool to write the exact text HOOK_FAIL into a file named proof.txt in the current directory. Then stop.' }],
    })
    // The turn completes normally (the block is a tool-result error fed back to
    // the model, not a turn failure).
    expect(['end_turn', 'max_tokens']).toContain(res.stopReason)

    // Verify the WORLD: the hook denied execution, so the file must NOT exist —
    // a keyword probe a "cheating" agent could fake in prose cannot pass this.
    await expect(access(join(workdir, 'proof.txt'))).rejects.toThrow()

    // The client still saw a tool_call stream (the model TRIED), and its result
    // carried the hook's block reason back as an error.
    const toolCalls = updates.filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
    expect(toolCalls.length).toBeGreaterThan(0)
  }, 180_000)
})
