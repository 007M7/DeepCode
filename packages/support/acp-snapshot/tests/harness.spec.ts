import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runScenario, type AgentUnderTest, type InputStep } from '../src/harness.ts'

/**
 * Unit tests for the subprocess harness, driven through the REAL spawn path
 * (tsx loader, temp cwd, env plumbing) against the scripted fake ACP bin in
 * ./fixtures/fake-acp-agent.ts. Each case writes a `behavior.json` next to a
 * throwaway fixture path; the fake bin echoes observable facts (env, seeded
 * workspace, permission outcomes) into `agent_message_chunk` text, so the
 * assertions read plain `rawStdout`.
 */

const AGENT: AgentUnderTest = {
  binScript: fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url)),
  // The fake bin ignores its config argv; any real path documents the shape.
  configPath: fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

/** Temp scenario dirs to drop after the suite. */
const tempDirs: string[] = []
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

/** Write a behavior.json into a fresh temp dir; return the sibling fixture path the harness points the bin at. */
async function scenario(behavior: object): Promise<{ dir: string; fixtureFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-snap-spec-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'behavior.json'), JSON.stringify(behavior))
  return { dir, fixtureFile: join(dir, 'session.jsonl') }
}

const boot: InputStep[] = [{ op: 'initialize' }, { op: 'newSession' }]

describe('runScenario', () => {
  it('drives a full turn: initialize (terminal caps), session, prompt, permission stub, harvest', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      permissionProbe: true,
      logs: [{
        file: 'bucket/main.jsonl',
        lines: [
          { type: 'session', id: '{{SID}}', createdAt: 42, cwd: '{{CWD}}' },
          { type: 'turn/start', seq: 1, time: 9, data: { turn: 1 } },
        ],
      }],
    })
    const result = await runScenario(
      { steps: [{ op: 'initialize', terminalOutput: true }, { op: 'newSession' }, { op: 'prompt', text: 'go' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionId).toBeDefined()
    // The harness's client answers a permission request with `cancelled`; the
    // fake bin echoes the outcome it received back as a chunk.
    expect(result.rawStdout).toContain('permission:{\\"outcome\\":\\"cancelled\\"}')
    expect(result.sessionLogs).toHaveLength(1)
    expect(result.sessionLogs[0]?.id).toBe(result.sessionId)
    expect(result.sessionLogs[0]?.createdAt).toBe(42)
    expect(result.sessionLogs[0]?.content).toContain('turn/start')
    // The harvested log embeds the run's REAL temp cwd (template-substituted).
    expect(result.sessionLogs[0]?.content).toContain(result.cwd)
  })

  it('forwards override/child fixture paths into the child env and captures stderr', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ echoEnv: true, stderrNote: 'fake bin booted' })
    const childFiles = [join(dir, 'session.1.jsonl'), join(dir, 'session.2.jsonl')]
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'env?' }] },
      {
        agent: AGENT,
        mode: 'replay',
        fixtureFile,
        overrideFile: join(dir, 'replay.override.json'),
        childFiles,
        // A workspaceDir that does not exist is skipped, not an error.
        workspaceDir: join(dir, 'no-such-workspace'),
      },
    )
    expect(result.stderr).toContain('fake bin booted')
    expect(result.rawStdout).toContain('replay.override.json')
    // Child paths ride one env var, joined with the platform delimiter.
    expect(result.rawStdout).toContain(JSON.stringify(childFiles.join(delimiter)).slice(1, -1))
  })

  it('seeds the workspace dir into the temp cwd before the run', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ echoWorkspace: true })
    const workspaceDir = join(dir, 'workspace')
    await writeFile(join(dir, 'behavior.json'), JSON.stringify({ echoWorkspace: true }))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'seeded.txt'), 'hello')
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'ls' }] },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceDir },
    )
    expect(result.rawStdout).toContain('workspace:seeded.txt')
  })

  it('promptAndCancel waits for the streamed chunk, cancels, and settles the prompt', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'hang-until-cancel' })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('"stopReason":"cancelled"')
    // The streamed chunk deterministically precedes the cancelled response.
    expect(result.rawStdout.indexOf('thinking about it')).toBeLessThan(result.rawStdout.indexOf('cancelled'))
  })

  it('promptExpectError swallows a model-error response as the expected outcome', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'error' })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptExpectError', text: 'boom' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('model exploded')
  })

  it('promptExpectError throws when the prompt unexpectedly succeeds (and teardown kills the live child)', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'respond' })
    await expect(runScenario(
      { steps: [...boot, { op: 'promptExpectError', text: 'fine' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/expected the prompt to fail/)
  })

  it('newSessionExpectError swallows the rejection, with and without extra dirs', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ rejectExtraDirs: true })
    const result = await runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError', additionalDirectories: ['/elsewhere'] }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    // No session was created, so no id and no logs.
    expect(result.sessionId).toBeUndefined()
    expect(result.sessionLogs).toHaveLength(0)

    const rejectAll = await scenario({ rejectNewSession: true })
    const second = await runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError' }] },
      { agent: AGENT, mode: 'replay', fixtureFile: rejectAll.fixtureFile },
    )
    expect(second.rawStdout).toContain('unsupported workspace scope')
  })

  it('newSessionExpectError throws when session/new unexpectedly succeeds', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    await expect(runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/expected session\/new to be rejected/)
  })

  it('a plain cancel step is forwarded (and ignored by an idle agent)', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const result = await runScenario(
      { steps: [...boot, { op: 'cancel' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionId).toBeDefined()
  })

  it.each([
    [{ op: 'prompt', text: 'x' }, /prompt before newSession/],
    [{ op: 'promptExpectError', text: 'x' }, /promptExpectError before newSession/],
    [{ op: 'promptAndCancel', text: 'x' }, /promptAndCancel before newSession/],
    [{ op: 'cancel' }, /cancel before newSession/],
    [{ op: 'setConfigOption', configId: 'sandbox-mode', value: 'read-only' }, /setConfigOption before newSession/],
    [{ op: 'setConfigOptionExpectError', configId: 'sandbox-mode', value: 'yolo' }, /setConfigOptionExpectError before newSession/],
  ] as [InputStep, RegExp][])('rejects %j before newSession', { timeout: 20_000 }, async (step, message) => {
    const { fixtureFile } = await scenario({})
    await expect(runScenario(
      { steps: [{ op: 'initialize' }, step] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(message)
  })

  it('setConfigOption switches a value and receives the complete refreshed option state', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      configOptions: { 'sandbox-mode': ['read-only', 'workspace-write'], 'approval-policy': ['ask', 'never'] },
    })
    const result = await runScenario(
      {
        steps: [...boot,
          { op: 'setConfigOption', configId: 'sandbox-mode', value: 'workspace-write' },
          { op: 'setConfigOption', configId: 'approval-policy', value: 'never' }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    // Every set answers with the FULL state: the second response carries the
    // first switch's value too — the complete-refreshed-state contract.
    const frames = result.rawStdout.trim().split('\n').map(line => JSON.parse(line) as { result?: { configOptions?: { id: string; currentValue: string }[] } })
    const states = frames
      .map(f => f.result?.configOptions)
      .filter(options => options !== undefined)
      .map(options => Object.fromEntries((options as { id: string; currentValue: string }[]).map(o => [o.id, o.currentValue])))
    expect(states).toEqual([
      { 'sandbox-mode': 'workspace-write', 'approval-policy': 'ask' },
      { 'sandbox-mode': 'workspace-write', 'approval-policy': 'never' },
    ])
  })

  it('setConfigOptionExpectError swallows the rejection for unknown ids and out-of-vocabulary values', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ configOptions: { 'sandbox-mode': ['read-only'] } })
    const result = await runScenario(
      {
        steps: [...boot,
          { op: 'setConfigOptionExpectError', configId: 'sandbox-mode', value: 'yolo' },
          { op: 'setConfigOptionExpectError', configId: 'reasoning-effort', value: 'max' }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('unknown sandbox-mode value yolo')
    expect(result.rawStdout).toContain('unknown config option reasoning-effort')
  })

  it('setConfigOptionExpectError throws when the set unexpectedly succeeds', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ configOptions: { 'sandbox-mode': ['read-only'] } })
    await expect(runScenario(
      { steps: [...boot, { op: 'setConfigOptionExpectError', configId: 'sandbox-mode', value: 'read-only' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/expected set_config_option to be rejected/)
  })

  it('rejects an unknown input op', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const bogus = { op: 'reticulate' } as unknown as InputStep
    await expect(runScenario(
      { steps: [bogus] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/unknown input op/)
  })

  it('harvests all logs primary-first, children by createdAt then id, skipping filesystem noise', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      strayRootFile: true,
      strayBucketFile: true,
      logs: [
        // File names chosen so readdir feeds the sort children-first AND
        // parent-in-the-middle: the comparator then sees a parent on both
        // sides of a pair, plus the same-createdAt (localeCompare) tiebreak.
        { file: 'b1/aa-child-c.jsonl', lines: [{ type: 'session', id: 'cccccccc-0000-4000-8000-000000000000', createdAt: 500, parentSession: '{{SID}}' }] },
        { file: 'b1/bb-parent.jsonl', lines: [{ type: 'session', id: '{{SID}}', createdAt: 900 }] },
        { file: 'b1/cc-child-a.jsonl', lines: [{ type: 'session', id: 'aaaaaaaa-0000-4000-8000-000000000000', createdAt: 500, parentSession: '{{SID}}' }] },
        // Missing id/createdAt fall back to ''/0; earliest child by createdAt.
        { file: 'b2/orphan-fields.jsonl', lines: [{ type: 'session', parentSession: '{{SID}}' }] },
      ],
    })
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'go' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs.map(l => [l.id, l.createdAt])).toEqual([
      [result.sessionId, 900],
      ['', 0],
      ['aaaaaaaa-0000-4000-8000-000000000000', 500],
      ['cccccccc-0000-4000-8000-000000000000', 500],
    ])
    expect(result.sessionLogs[1]?.parentSession).toBe(result.sessionId)
  })

  it('treats an empty log file as a header-less primary with default fields', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ logs: [{ file: 'b/empty.jsonl', lines: [] }] })
    const result = await runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs.map(l => [l.id, l.createdAt, l.parentSession])).toEqual([['', 0, undefined]])
  })

  it('yields no logs when the sessions root vanished', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ deleteSessionsRoot: true })
    const result = await runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs).toHaveLength(0)
  })

  it('answers permission requests from the scripted queue by option kind, falling back to cancelled', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    // Two prompts → two permission round-trips; one scripted answer, so the
    // second request exercises the exhausted-queue fallback.
    const result = await runScenario(
      {
        steps: [...boot, { op: 'prompt', text: 'one' }, { op: 'prompt', text: 'two' }],
        permissionAnswers: [{ kind: 'allow_once' }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    const first = result.rawStdout.indexOf('permission:{\\"outcome\\":\\"selected\\",\\"optionId\\":\\"opt-allow\\"}')
    const second = result.rawStdout.indexOf('permission:{\\"outcome\\":\\"cancelled\\"}')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('selects a non-first offered option by kind', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'deny it' }], permissionAnswers: [{ kind: 'reject_once' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('permission:{\\"outcome\\":\\"selected\\",\\"optionId\\":\\"opt-reject\\"}')
  })

  it('rejects the run on a scripted permission kind the agent never offered', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    // The fake bin offers allow_once/reject_once; scripting allow_always is a
    // scenario bug. The agent is answered `cancelled` (it must not be able to
    // absorb the bug as an error-means-denial), and the RUN fails: a callback
    // throw would only reach the agent as a JSON-RPC error response, letting
    // a tolerant agent carry on and the scenario pass — or record.
    await expect(runScenario(
      { steps: [...boot, { op: 'prompt', text: 'impossible click' }], permissionAnswers: [{ kind: 'allow_always' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/allow_always not among the offered options \[allow_once, reject_once\]/)
  })
})
