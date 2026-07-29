import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SourceGuard from '@deepseek-ai/dsh-source-guard'
import type { Config } from '@deepseek-ai/dsh-source-guard'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the staging-source guard: worktree resolution over REAL
 * git metadata fixtures (a staging worktree, a nested task worktree, a plain
 * clone, an unrelated repository, a detached HEAD), skill satisfaction replayed
 * from the durable session log, and fail-loud config validation — all driven
 * through a real agent loop against a scripted mock adapter (no network).
 */

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Build a git-metadata fixture tree that mirrors the real installer layout: a
 * `master` clone holding the shared git directory, linked worktrees registered
 * under `master/.git/worktrees/<name>`, and one file per worktree to target.
 */
async function fixture(): Promise<{
  /** Absolute path of the fixture container. */
  root: string
  /** A file inside the staging worktree — the protected target. */
  stagingFile: string
  /** A file inside a task worktree NESTED under the staging tree. */
  taskFile: string
  /** A file inside a SIBLING staging worktree of the same repository, on another branch. */
  siblingFile: string
  /** A file inside the plain master clone. */
  masterFile: string
  /** A file inside a worktree whose HEAD is detached. */
  detachedFile: string
  /** A file inside an unrelated repository sharing no git directory. */
  outsideFile: string
  /** A file under no repository at all. */
  looseFile: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'source-guard-'))
  roots.push(root)
  const master = join(root, 'master')
  const gitDir = join(master, '.git')
  await mkdir(join(gitDir, 'worktrees'), { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/master\n')
  await writeFile(join(master, 'file.ts'), 'master\n')

  /** Register one linked worktree at `path` whose HEAD file holds `head`. */
  async function linked(path: string, name: string, head: string): Promise<string> {
    const worktreeGitDir = join(gitDir, 'worktrees', name)
    await mkdir(worktreeGitDir, { recursive: true })
    await writeFile(join(worktreeGitDir, 'HEAD'), head)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, '.git'), `gitdir: ${worktreeGitDir}\n`)
    const file = join(path, 'file.ts')
    await writeFile(file, 'content\n')
    return file
  }

  const staging = join(root, 'staging-20260728T022827Z')
  const stagingFile = await linked(staging, 'staging-20260728T022827Z', 'ref: refs/heads/dsh-staging/20260728T022827Z\n')
  // The prescribed workflow's task worktree lives INSIDE the staging tree.
  const taskFile = await linked(join(staging, '.worktrees', 'task', 'x'), 'task-x', 'ref: refs/heads/task/x\n')
  // A stale staging worktree from an earlier install: same repository, different branch.
  const siblingFile = await linked(
    join(root, 'staging-20260727T045831Z'),
    'staging-20260727T045831Z',
    'ref: refs/heads/dsh-staging/20260727T045831Z\n',
  )
  const detachedFile = await linked(join(root, 'detached'), 'detached', '0123456789abcdef0123456789abcdef01234567\n')

  const outside = join(root, 'outside')
  await mkdir(join(outside, '.git'), { recursive: true })
  await writeFile(join(outside, '.git', 'HEAD'), 'ref: refs/heads/dsh-staging/20260728T022827Z\n')
  const outsideFile = join(outside, 'file.ts')
  await writeFile(outsideFile, 'outside\n')

  const loose = join(root, 'loose')
  await mkdir(loose, { recursive: true })
  const looseFile = join(loose, 'file.ts')
  await writeFile(looseFile, 'loose\n')

  return {
    root, stagingFile, taskFile, siblingFile, masterFile: join(master, 'file.ts'), detachedFile, outsideFile, looseFile,
  }
}

/**
 * Boot the core spine, a real local filesystem, and the guard, pointing
 * `protectedCheckout` at a fixture path so the guard arms for the fixture
 * repository instead of the checkout these tests actually run in.
 */
async function harness(protectedCheckout: string, config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SourceGuard, { ...config, protectedCheckout })
  for (const name of ['write', 'edit', 'read', 'skill']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: { file_path: { type: 'string' }, name: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
  }
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Every tool result in the agent's log as `{ isError, text }`, in log order. */
function results(agent: Agent): { isError: boolean; text: string }[] {
  return [...agent.session.events]
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content[0])
    .map(result => ({
      isError: result.isError === true,
      text: result.content.map(block => block.type === 'text' ? block.text : '').join(''),
    }))
}

/**
 * Durable events recording completed `skill` calls, as a RESUMED session's seed:
 * the guard's satisfaction check then has nothing but the log to read, with no
 * in-memory state from an original run to fall back on.
 */
function priorSkillCalls(calls: { arguments: string; isError?: boolean }[]): SessionEvent[] {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
  ]
  for (const [index, call] of calls.entries()) {
    const callId = CallId(`prior${index}`)
    const seq = events.length
    events.push({
      type: 'tool/call',
      seq,
      time: seq + 1,
      data: { turn: 1, step: 1, callId, name: 'skill', arguments: call.arguments },
    })
    events.push({
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 2,
      surfaceOp: 'append',
      sourceEventSeqs: [seq],
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'loaded' }],
          isError: call.isError ?? false,
        }),
      },
    })
  }
  const tail = events.length
  events.push({ type: 'step/end', seq: tail, time: tail + 1, data: { turn: 1, step: 1 } })
  events.push({ type: 'turn/end', seq: tail + 1, time: tail + 2, data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

/** Resume a session from durable seed events and let the model attempt one write at `path`. */
async function resume(ctx: Context, id: string, seed: SessionEvent[], path: string): Promise<Agent> {
  const adapter = new MockAdapter([
    toolCallResponse(CallId('c0'), 'write', { file_path: path }),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(id),
    seed,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

/** Drive one turn whose scripted model output is the given tool calls, then a closing text. */
async function run(
  ctx: Context,
  calls: { name: string; args: Record<string, unknown> }[],
  cwd?: string,
): Promise<Agent> {
  const adapter = new MockAdapter([
    ...calls.map((call, index) => toolCallResponse(CallId(`c${index}`), call.name, call.args)),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(
    SessionId('s1'),
    { provider: 'mock', model: 'mock' },
    cwd === undefined ? {} : { cwd },
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

describe('staging protection', () => {
  it('denies a write inside the staging worktree and names the path, branch, and skill', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.stagingFile } }])
    const [result] = results(agent)
    expect(result?.isError).toBe(true)
    expect(result?.text).toBe(
      `Error: Editing "${paths.stagingFile}" directly is not allowed: it is inside the dsh checkout this session is running from, `
      + 'on branch dsh-staging/20260728T022827Z. Load the dsh-customize skill first and follow it '
      + '— implement in a task worktree, then integrate under the staging lock.',
    )
  })

  it('denies an edit inside the staging worktree', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'edit', args: { file_path: paths.stagingFile } }])
    expect(results(agent)[0]?.isError).toBe(true)
  })

  it('allows a read inside the staging worktree, since inspection never violates the skill', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'read', args: { file_path: paths.stagingFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write inside a task worktree nested under the staging tree', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.taskFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write in the plain clone that owns the shared git directory', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.masterFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write on a staging-named branch in an unrelated repository', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.outsideFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write under a detached HEAD, which names no branch to match', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.detachedFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write when the git metadata exists but cannot be read', async () => {
    const paths = await fixture()
    // A `.git` pointer that stats as a file yet fails to read leaves the guard
    // with no branch to judge; failing open beats blocking every edit.
    const unreadable = join(paths.root, 'unreadable')
    await mkdir(unreadable, { recursive: true })
    await writeFile(join(unreadable, '.git'), `gitdir: ${join(paths.root, 'master', '.git')}\n`)
    await chmod(join(unreadable, '.git'), 0o000)
    const file = join(unreadable, 'file.ts')
    await writeFile(file, 'content\n')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: file } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('allows a write under no repository at all', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.looseFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('arms for nothing when its own location is inside no repository', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.looseFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.stagingFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('arms for nothing when the launcher checkout has a detached HEAD', async () => {
    const paths = await fixture()
    // A detached launcher names no branch, so there is no branch to protect.
    const ctx = await harness(paths.detachedFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.stagingFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('denies when the target and the protected checkout reach one repository through different symlinks', async () => {
    const paths = await fixture()
    // macOS reaches the temp directory through both `/var/...` and
    // `/private/var/...`; a lexical repository comparison would treat the two
    // routes as different repositories and fail open on every write.
    const link = join(paths.root, 'link')
    await symlink(dirname(paths.stagingFile), link, 'dir')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: join(link, 'file.ts') } }])
    expect(results(agent)[0]?.text).toContain('on branch dsh-staging/20260728T022827Z')
  })

  it('denies a RELATIVE target path resolved against the session workspace', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    // The filesystem tools resolve a relative `file_path` against the session
    // cwd, so judging only absolute paths would leave this as an unguarded
    // route to the same file.
    const agent = await run(ctx, [{ name: 'write', args: { file_path: 'file.ts' } }], dirname(paths.stagingFile))
    expect(results(agent)[0]?.text).toContain('directly is not allowed')
  })

  it('ignores a relative target path when the session names no workspace', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: 'file.ts' } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('ignores a call whose target path is an empty string', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: '' } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it.each([
    ['a non-string file_path', { file_path: 7 }],
    ['no file_path at all', { other: 'x' }],
  ])('ignores a gated call carrying %s', async (_label, args) => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args }])
    expect(results(agent)[0]?.text).not.toContain('directly is not allowed')
  })

  it('ignores a gated call whose arguments are not JSON, which the loop keeps as raw text', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const callId = CallId('raw')
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'write', argumentsDelta: 'not json' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'write', arguments: 'not json' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('raw'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(results(agent)[0]?.text).not.toContain('directly is not allowed')
  })

  it.each([
    ['a `.git` pointer that names no git directory', 'not a gitdir pointer\n'],
    ['an empty `.git` pointer', 'gitdir:\n'],
    ['a `.git` pointer into a nonexistent git directory', 'gitdir: /nonexistent/worktrees/x\n'],
  ])('allows a write behind %s', async (_label, pointer) => {
    const paths = await fixture()
    const broken = join(paths.root, 'broken')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, '.git'), pointer)
    const file = join(broken, 'file.ts')
    await writeFile(file, 'content\n')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: file } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('denies behind a RELATIVE `.git` pointer, which git resolves against the worktree', async () => {
    const paths = await fixture()
    // `git worktree add` writes an absolute pointer, but a relocated or
    // hand-written one may be relative; git accepts both, so the guard must
    // resolve both or it would fail open on a real repository layout.
    const relative = join(paths.root, 'relative-pointer')
    await mkdir(relative, { recursive: true })
    await writeFile(join(relative, '.git'), 'gitdir: ../master/.git/worktrees/staging-20260728T022827Z\n')
    const file = join(relative, 'file.ts')
    await writeFile(file, 'content\n')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: file } }])
    expect(results(agent)[0]?.text).toContain('on branch dsh-staging/20260728T022827Z')
  })

  it('allows a write when the worktree resolves but its HEAD is missing', async () => {
    const paths = await fixture()
    const gitDir = join(paths.root, 'master', '.git', 'worktrees', 'headless')
    await mkdir(gitDir, { recursive: true })
    const headless = join(paths.root, 'headless')
    await mkdir(headless, { recursive: true })
    await writeFile(join(headless, '.git'), `gitdir: ${gitDir}\n`)
    const file = join(headless, 'file.ts')
    await writeFile(file, 'content\n')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: file } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('reuses one resolution for sibling targets in the same directory', async () => {
    const paths = await fixture()
    const sibling = join(dirname(paths.stagingFile), 'other.ts')
    await writeFile(sibling, 'content\n')
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [
      { name: 'write', args: { file_path: paths.stagingFile } },
      { name: 'write', args: { file_path: sibling } },
    ])
    expect(results(agent).map(result => result.isError)).toEqual([true, true])
  })

  it('protects whichever branch the launcher checkout is on, whatever its name', async () => {
    const paths = await fixture()
    // The protected branch is read from `protectedCheckout`'s own worktree, so
    // a checkout on an unconventional branch name is still protected — a
    // hardcoded name pattern would have silently guarded nothing.
    const ctx = await harness(paths.taskFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.taskFile } }])
    expect(results(agent)[0]?.text).toContain('on branch task/x')
  })

  it('allows a write in a SIBLING checkout of the same repository on another branch', async () => {
    const paths = await fixture()
    // A stale staging worktree left by an earlier install shares the
    // repository but is not the live deployment, so the workflow rule the
    // guard enforces does not apply to it.
    const ctx = await harness(paths.siblingFile)
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.stagingFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })

  it('gates only the configured tools', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile, { tools: ['edit'] })
    const agent = await run(ctx, [
      { name: 'write', args: { file_path: paths.stagingFile } },
      { name: 'edit', args: { file_path: paths.stagingFile } },
    ])
    expect(results(agent).map(result => result.isError)).toEqual([false, true])
  })
})

describe('skill satisfaction', () => {
  it('allows the write after a successful load of the required skill in the same turn', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [
      { name: 'skill', args: { name: 'dsh-customize' } },
      { name: 'write', args: { file_path: paths.stagingFile } },
    ])
    expect(results(agent)).toEqual([
      { isError: false, text: 'ok' },
      { isError: false, text: 'ok' },
    ])
  })

  it('allows the write when the skill load is only in the REPLAYED log, so resume keeps satisfaction', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const seed = priorSkillCalls([{ arguments: JSON.stringify({ name: 'dsh-customize' }) }])
    const agent = await resume(ctx, 'resumed', seed, paths.stagingFile)
    expect(results(agent).at(-1)).toEqual({ isError: false, text: 'ok' })
  })

  it('does not accept a failed skill load', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const seed = priorSkillCalls([{ arguments: JSON.stringify({ name: 'dsh-customize' }), isError: true }])
    const agent = await resume(ctx, 'failed', seed, paths.stagingFile)
    expect(results(agent).at(-1)?.isError).toBe(true)
  })

  it('does not accept a different skill', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const agent = await run(ctx, [
      { name: 'skill', args: { name: 'dsh-upgrade' } },
      { name: 'write', args: { file_path: paths.stagingFile } },
    ])
    expect(results(agent).map(result => result.isError)).toEqual([false, true])
  })

  it('does not accept a skill call whose arguments are not a JSON object naming a string', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const seed = priorSkillCalls([
      { arguments: 'not json' },
      { arguments: '[]' },
      { arguments: '{"name":7}' },
      { arguments: 'null' },
    ])
    const agent = await resume(ctx, 'malformed', seed, paths.stagingFile)
    expect(results(agent).at(-1)?.isError).toBe(true)
  })

  it('honours a configured skill name other than the default', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile, { requiredSkill: 'other-skill' })
    const agent = await run(ctx, [
      { name: 'skill', args: { name: 'other-skill' } },
      { name: 'write', args: { file_path: paths.stagingFile } },
    ])
    expect(results(agent).map(result => result.isError)).toEqual([false, false])
  })
})

describe('non-agent callers', () => {
  it('leaves a direct registry call ungated, having no session to replay', async () => {
    const paths = await fixture()
    const ctx = await harness(paths.stagingFile)
    const result = await ctx.tools.execute({
      callId: CallId('direct'),
      name: 'write',
      arguments: { file_path: paths.stagingFile },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
  })
})

describe('config validation', () => {
  it.each([
    ['tools', { tools: [] }, '`tools` must not be empty'],
    ['requiredSkill', { requiredSkill: '  ' }, '`requiredSkill` must not be blank'],
    ['protectedCheckout', { protectedCheckout: 'relative/path' }, '`protectedCheckout` must be an absolute path'],
  ])('rejects an invalid %s at load', async (_field, config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, {})
    await expect(ctx.plugin(SourceGuard, config as Config)).rejects.toThrow(message)
  })
})

describe('disposal', () => {
  it('stops gating once the plugin fiber is disposed', async () => {
    const paths = await fixture()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, {})
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(SourceGuard, { protectedCheckout: paths.stagingFile })
    for (const name of ['write', 'skill']) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: name,
        parameters: { file_path: { type: 'string' }, name: { type: 'string' } },
        async execute() { return [{ type: 'text', text: 'ok' }] },
      }))
    }
    await fiber.dispose()
    const agent = await run(ctx, [{ name: 'write', args: { file_path: paths.stagingFile } }])
    expect(results(agent)).toEqual([{ isError: false, text: 'ok' }])
  })
})
