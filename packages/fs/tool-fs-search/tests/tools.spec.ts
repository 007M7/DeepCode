/**
 * Consumer-surface tests for the search tools over a FAKE bash executor and a
 * FAKE spill backend, exercised through `ctx.tools.execute()` so nothing
 * bypasses the tool registry. The fake executor makes every seam outcome
 * scriptable — registration-time `rg` probing, truncated stdout with/without a
 * raw spill path, abort/timeout, signal kills, ripgrep exit codes — so these
 * tests verify schemas, argument validation, shell-safe command construction,
 * workdir derivation, signal forwarding, `SEARCH_*` error classification,
 * retention, formatted-result spill handoff, and the no-background-task
 * invariant. Real-`rg` behavior is pinned separately in integration.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import {
  buildGlobCommand,
  buildGrepCommand,
  formatGrepMatches,
  parseGrepMatches,
  presentGlobCall,
  presentGrepCall,
  previewLine,
  toWorkdirRelative,
} from '@deepseek-ai/dsh-tool-fs-search'

const testToolSignal = new AbortController().signal
const RG_PROBE_COMMAND = 'command -v rg >/dev/null 2>&1'

/** A successful run result over the given stdout; overrides script the failure shapes. */
function runResult(stdout: string, overrides?: Partial<BashRunResult>): BashRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/**
 * A scriptable fake executor: `resolve()` mirrors the real request→spec
 * defaulting (workdir falls back to `/work`), `run()` returns whatever the
 * test armed via `handler`, and `start()` throws — the search tools must NEVER
 * create a background task.
 */
class FakeBash extends BashExecutor {
  probeRequests: BashExecRequest[] = []
  probeSpecs: BashExecSpec[] = []
  requests: BashExecRequest[] = []
  specs: BashExecSpec[] = []
  startCalls = 0
  forwardSignal = true
  probeResult: BashRunResult = runResult('')
  probeError?: Error
  handler: (spec: BashExecSpec) => BashRunResult = () => runResult('')

  override resolve(request: BashExecRequest): BashExecSpec {
    if (request.command === RG_PROBE_COMMAND) this.probeRequests.push(request)
    else this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? '/work',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...this.forwardSignal ? { signal: request.signal } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }
  override async run(spec: BashExecSpec): Promise<BashRunResult> {
    if (spec.command === RG_PROBE_COMMAND) {
      this.probeSpecs.push(spec)
      if (this.probeError) throw this.probeError
      return this.probeResult
    }
    this.specs.push(spec)
    return this.handler(spec)
  }
  override start(): BashProcess {
    this.startCalls++
    throw new Error('search tools must never start a background task')
  }
}

/** A recording spill backend; arm `failWith` to script a storage failure. */
class FakeSpill extends SpillStore {
  saves: SaveTextSpill[] = []
  failWith?: Error

  override saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.failWith) return Promise.reject(this.failWith)
    this.saves.push(input)
    return Promise.resolve({
      locator: SpillLocator(`/spill/${input.suggestedName}`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use the fake retrieval hint.',
    })
  }
}

interface SetupOptions {
  config?: ToolFsSearch.Config
  spill?: boolean
  probeError?: Error
  probeResult?: BashRunResult
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(FakeBash)
  const bash = ctx.bash as FakeBash
  if (options.probeResult) bash.probeResult = options.probeResult
  if (options.probeError) bash.probeError = options.probeError
  if (options.spill === true) await ctx.plugin(FakeSpill)
  const fiber = await ctx.plugin(ToolFsSearch, options.config)
  const spill = options.spill === true ? ctx.get('spillStore') as FakeSpill : undefined
  return { ctx, bash, spill, fiber, warnings }
}

/** Assert plugin setup rejects without letting Vitest pretty-print a live Context on failure. */
async function expectSetupRejects(options: SetupOptions, message: RegExp): Promise<void> {
  let thrown: string | undefined
  try {
    const loaded = await setup(options)
    await loaded.fiber.dispose()
  } catch (error: unknown) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  expect(thrown).toMatch(message)
}

/** A stand-in agent whose session header carries the given cwd (and a stable id). */
const agent = (cwd?: string) => ({ session: { header: { id: 'session-1', ...cwd !== undefined ? { cwd } : {} } } })

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, options: { agent?: object; signal?: AbortSignal } = {}) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...options.agent ? { agent: options.agent as never } : {},
    ...options.signal ? { signal: options.signal } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** One rg --json match record line. */
function matchLine(path: string, lineNumber: number, lineText: string): string {
  return JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text: lineText }, line_number: lineNumber, absolute_offset: 0, submatches: [] } })
}

describe('registration', () => {
  it('registers glob and grep with their prompt sections', async () => {
    const { ctx, bash } = await setup()
    expect(bash.probeRequests).toHaveLength(1)
    expect(bash.probeRequests[0]?.command).toBe(RG_PROBE_COMMAND)
    expect(bash.probeRequests[0]).not.toHaveProperty('workdir')
    expect(ctx.tools.schemas().map(s => s.name).sort()).toEqual(['glob', 'grep'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use the glob tool')
    expect(prompt).toContain('Use the grep tool')
  })

  it('does not register glob or grep when the bash executor cannot find rg', async () => {
    const { ctx, warnings } = await setup({ probeResult: runResult('', { exitCode: 1 }) })
    expect(ctx.tools.schemas()).toHaveLength(0)
    const sections = (await ctx.systemPrompt.assemble()).sections.map(s => s.name)
    expect(sections).not.toContain('tool:glob')
    expect(sections).not.toContain('tool:grep')
    expect(warnings).toEqual([
      'tool-fs-search: ripgrep (rg) not found on the bash executor PATH; glob/grep tools not registered',
    ])
  })

  it('rejects plugin load when the rg availability probe cannot run', async () => {
    await expectSetupRejects({ probeError: new Error('spawn bash ENOENT') }, /spawn bash ENOENT/)
  })

  it('rejects plugin load when the rg availability probe is aborted or killed', async () => {
    await expectSetupRejects({
      probeResult: runResult('', { aborted: true, exitCode: null, signal: 'SIGTERM' }),
    }, /tool-fs-search: ripgrep availability probe did not complete/)
  })

  it('stays pending until ctx.bash exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(ToolFsSearch) // no bash executor
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas()).toHaveLength(2)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
    const sections = (await ctx.systemPrompt.assemble()).sections.map(s => s.name)
    expect(sections).not.toContain('tool:glob')
    expect(sections).not.toContain('tool:grep')
  })

  it('attaches the configured timeoutMs to both tool definitions', async () => {
    const { ctx } = await setup({ config: { timeoutMs: 5000 } })
    expect(ctx.tools.get('glob')?.timeoutMs).toBe(5000)
    expect(ctx.tools.get('grep')?.timeoutMs).toBe(5000)
  })

  it('defaults the timeout budget to 30 seconds', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('glob')?.timeoutMs).toBe(30_000)
    expect(ctx.tools.get('grep')?.timeoutMs).toBe(30_000)
  })
})

describe('config validation', () => {
  it.each([
    ['globMaxResults', { globMaxResults: 0 }],
    ['grepMaxMatches', { grepMaxMatches: -1 }],
    ['grepMaxLineBytes', { grepMaxLineBytes: 1.5 }],
    ['rawOutputMaxBytes', { rawOutputMaxBytes: 0 }],
    ['timeoutMs', { timeoutMs: -100 }],
  ] as const)('rejects a non-positive or fractional %s at load', async (name, config) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FakeBash)
    await expect(ctx.plugin(ToolFsSearch, config)).rejects.toThrow(new RegExp(`tool-fs-search: ${name} must be a positive integer`))
  })
})

describe('command construction (shell-safe)', () => {
  it('glob: fixed rg --files template with quoted pattern and paired VCS excludes', () => {
    const command = buildGlobCommand({ pattern: '**/*.ts' })
    expect(command).toBe(
      "rg --files --glob='**/*.ts' --sort=modified --no-ignore --hidden "
      + "--glob='!**/.git' --glob='!**/.git/**' --glob='!**/.svn' --glob='!**/.svn/**' "
      + "--glob='!**/.hg' --glob='!**/.hg/**' --glob='!**/.bzr' --glob='!**/.bzr/**' "
      + "--glob='!**/.jj' --glob='!**/.jj/**' --glob='!**/.sl' --glob='!**/.sl/**'",
    )
  })

  it('glob: the search root rides behind -- and is quoted', () => {
    const command = buildGlobCommand({ pattern: '*.md', path: 'docs dir' })
    expect(command).toContain("-- 'docs dir'")
  })

  it('grep: fixed rg --json template with the pattern in --regexp= form', () => {
    expect(buildGrepCommand({ pattern: 'foo.*bar' })).toBe("rg --json --regexp='foo.*bar'")
  })

  it('grep: include and path are quoted, include in --glob= form, path behind --', () => {
    const command = buildGrepCommand({ pattern: 'x', path: '-leading-dash', include: '*.{ts,tsx}' })
    expect(command).toBe("rg --json --regexp='x' --glob='*.{ts,tsx}' -- '-leading-dash'")
  })

  it.each([
    ['a command-substitution pattern', '$(rm -rf /)', "'$(rm -rf /)'"],
    ['a backtick pattern', '`touch pwned`', "'`touch pwned`'"],
    ['a pattern with double quotes and spaces', 'say "hi there"', '\'say "hi there"\''],
    ['a pattern with single quotes', "it's", '\'it\'\\\'\'s\''],
    ['a pattern with newlines', 'a\nb', "'a\nb'"],
    ['a leading-dash pattern', '--flag', "'--flag'"],
    ['glob metacharacters', '*?[a-z]{x,y}', "'*?[a-z]{x,y}'"],
  ])('quotes %s into one inert shell word', (_label, raw, quoted) => {
    expect(buildGrepCommand({ pattern: raw })).toBe(`rg --json --regexp=${quoted}`)
  })
})

describe('workdir derivation and signal forwarding', () => {
  it('forwards the session cwd as the request workdir', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('a.ts\n')
    await call(ctx, 'glob', { pattern: '*' }, { agent: agent('/sessions/s1') })
    expect(bash.requests[0]?.workdir).toBe('/sessions/s1')
    expect(bash.specs[0]?.workdir).toBe('/sessions/s1')
  })

  it('omits the request workdir without a session cwd so resolve() defaults apply', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('a.ts\n')
    await call(ctx, 'glob', { pattern: '*' }, { agent: agent() })
    expect(bash.requests[0]).not.toHaveProperty('workdir')
    expect(bash.specs[0]?.workdir).toBe('/work')
    // A non-agent caller takes the same default path.
    await call(ctx, 'grep', { pattern: 'x' })
    expect(bash.requests[1]).not.toHaveProperty('workdir')
  })

  it('forwards exec.signal into the bash spec', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    bash.handler = () => runResult('')
    const result = await call(ctx, 'grep', { pattern: 'x' }, { signal: controller.signal })
    expect(bash.specs[0]?.signal).toBe(controller.signal)
    expect(result.isError).toBe(false)
  })

  it('reports the bash executor timeout as SEARCH_ABORTED with the budget', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { timedOut: true, timeoutMs: 1234, exitCode: null, signal: 'SIGTERM' })
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ code: 'SEARCH_ABORTED' })
    expect(text(result)).toContain('timed out after 1234ms')
  })

  it('skips a pre-aborted registry call before run()', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    controller.abort()
    bash.handler = () => { throw new Error('aborted before spawn') }
    const result = await call(ctx, 'grep', { pattern: 'x' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH })
    expect(bash.specs).toHaveLength(0)
  })

  it('translates a run() rejection after the forwarded signal aborts', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    bash.handler = () => {
      controller.abort('cancel search')
      throw new Error('executor stopped on abort')
    }

    const result = await call(ctx, 'grep', { pattern: 'x' }, { signal: controller.signal })

    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'SearchError', code: 'SEARCH_ABORTED' })
    expect(text(result)).toContain('aborted before completion')
  })

  it('translates an aborted executor result after dispatch starts', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { aborted: true, exitCode: null })

    const result = await call(ctx, 'glob', { pattern: '*' })

    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'SearchError', code: 'SEARCH_ABORTED' })
    expect(text(result)).toContain('aborted before completion')
  })

  it('translates a run() rejection without an abort (unusable workdir) into SEARCH_FAILED', async () => {
    const { ctx, bash } = await setup()
    bash.forwardSignal = false
    bash.handler = () => { throw new Error('spawn bash ENOENT') }
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
    expect(text(result)).toContain('could not start')
  })
})

describe('exit semantics and failure classification', () => {
  it('exit 1 is a successful empty search', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 1 })
    const glob = await call(ctx, 'glob', { pattern: '*.nope' })
    expect(glob.isError).toBe(false)
    expect(text(glob)).toBe('No files found')
    const grep = await call(ctx, 'grep', { pattern: 'nope' })
    expect(grep.isError).toBe(false)
    expect(text(grep)).toBe('No matches found')
  })

  it('a regex parse error classifies as SEARCH_INVALID_PATTERN', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 2, stderr: { text: 'rg: regex parse error:\n    (\nerror: unclosed group', truncated: false } })
    const result = await call(ctx, 'grep', { pattern: '(' })
    expect(result.error).toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
    expect(text(result)).toContain('regex parse error')
  })

  it('a glob parse error classifies as SEARCH_INVALID_PATTERN', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 2, stderr: { text: 'rg: error parsing glob \'[\': unclosed character class', truncated: false } })
    const result = await call(ctx, 'glob', { pattern: '[' })
    expect(result.error).toMatchObject({ code: 'SEARCH_INVALID_PATTERN' })
  })

  it('a missing rg binary classifies as SEARCH_FAILED naming ripgrep', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 127, stderr: { text: 'bash: line 1: rg: command not found', truncated: false } })
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.error).toMatchObject({ code: 'SEARCH_FAILED' })
    expect(text(result)).toContain('requires ripgrep (rg)')
    // The same classification holds from either evidence alone: the 127 exit
    // with silent stderr, or a shell's command-not-found text on another exit.
    bash.handler = () => runResult('', { exitCode: 127 })
    expect(text(await call(ctx, 'glob', { pattern: '*' }))).toContain('requires ripgrep (rg)')
    bash.handler = () => runResult('', { exitCode: 2, stderr: { text: 'sh: rg: command not found', truncated: false } })
    expect(text(await call(ctx, 'grep', { pattern: 'x' }))).toContain('requires ripgrep (rg)')
  })

  it('other nonzero exits are SEARCH_FAILED carrying the stderr excerpt', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 2, stderr: { text: 'rg: missing.dir: IO error: no such file or directory', truncated: false } })
    const result = await call(ctx, 'grep', { pattern: 'x', path: 'missing.dir' })
    expect(result.error).toMatchObject({ code: 'SEARCH_FAILED' })
    expect(text(result)).toContain('IO error')
  })

  it('a nonzero exit with EMPTY stderr still reports the exit code', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 3 })
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.error).toMatchObject({ code: 'SEARCH_FAILED' })
    expect(text(result)).toContain('exit 3')
  })

  it('truncated stderr gains a truncation note and stderr.spillPath is never read', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', {
      exitCode: 2,
      stderr: { text: 'tail of diagnostics', truncated: true, spillPath: '/does/not/exist-and-never-read' },
    })
    const result = await call(ctx, 'grep', { pattern: 'x' })
    expect(text(result)).toContain('tail of diagnostics [stderr truncated]')
  })

  it('a signal kill (not timeout, not abort) is SEARCH_FAILED', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: null, signal: 'SIGKILL' })
    const result = await call(ctx, 'grep', { pattern: 'x' })
    expect(result.error).toMatchObject({ code: 'SEARCH_FAILED' })
    expect(text(result)).toContain('SIGKILL')
  })

  it('a null exit with no signal (defensive) is SEARCH_FAILED', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: null, signal: null })
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.error).toMatchObject({ code: 'SEARCH_FAILED' })
  })
})

describe('raw output acquisition', () => {
  it('passes rawOutputMaxBytes to bash as the stdout capture budget', async () => {
    const { ctx, bash } = await setup({ config: { rawOutputMaxBytes: 1234 } })
    bash.handler = () => runResult('', { exitCode: 1 })
    await call(ctx, 'glob', { pattern: '*.ts' })
    await call(ctx, 'grep', { pattern: 'needle' })
    expect(bash.requests.map(request => request.stdoutMaxBytes)).toEqual([1234, 1234])
    expect(bash.specs.map(spec => spec.stdoutMaxBytes)).toEqual([1234, 1234])
  })

  it('fails with SEARCH_RAW_OUTPUT_OVERFLOW when truncated stdout has a raw spill path', async () => {
    const { ctx, bash } = await setup({ config: { rawOutputMaxBytes: 16 } })
    bash.handler = () => runResult('', { stdout: { text: 'x', truncated: true, spillPath: '/does/not/get-read' } })
    const result = await call(ctx, 'glob', { pattern: '*' })
    expect(result.error).toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
    expect(text(result)).toContain('narrow pattern, path, or include')
  })

  it('fails with SEARCH_RAW_OUTPUT_OVERFLOW when UNTRUNCATED inline stdout exceeds the cap', async () => {
    // An executor retaining more inline than this package's cap (or a
    // deployment lowering rawOutputMaxBytes below the bash retention) must not
    // smuggle an over-cap parse through the untruncated path.
    const { ctx, bash } = await setup({ config: { rawOutputMaxBytes: 16 } })
    bash.handler = () => runResult(`${'x'.repeat(64)}\n`)
    const result = await call(ctx, 'grep', { pattern: 'x' })
    expect(result.error).toMatchObject({ name: 'SearchError', code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
    expect(text(result)).toContain('narrow pattern, path, or include')
  })

  it('fails with SEARCH_RAW_OUTPUT_OVERFLOW when truncated stdout has no spill path', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { stdout: { text: 'partial', truncated: true } })
    const result = await call(ctx, 'grep', { pattern: 'x' })
    expect(result.error).toMatchObject({ code: 'SEARCH_RAW_OUTPUT_OVERFLOW' })
  })
})

describe('glob results', () => {
  it('lists workdir-relative paths (absolute output under the workdir is relativized)', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('/sessions/s1/src/a.ts\n/elsewhere/b.ts\nrel/c.ts\n')
    const result = await call(ctx, 'glob', { pattern: '*' }, { agent: agent('/sessions/s1') })
    expect(text(result)).toBe(`${join('src', 'a.ts')}\n/elsewhere/b.ts\nrel/c.ts`)
  })

  it('validates arguments (blank pattern, blank path)', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'glob', { pattern: '  ' }))).toContain('pattern must be a non-empty string')
    expect(text(await call(ctx, 'glob', { pattern: '*', path: ' ' }))).toContain('path must be a non-empty string')
  })

  it('threads a valid path through to the command as the quoted search root', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('sub/a.ts\n')
    const result = await call(ctx, 'glob', { pattern: '*.ts', path: 'sub' })
    expect(result.isError).toBe(false)
    expect(bash.specs[0]?.command).toContain("-- 'sub'")
  })

  it('caps at globMaxResults and saves the FULL sorted list through spillStore', async () => {
    const { ctx, bash, spill } = await setup({ config: { globMaxResults: 2 }, spill: true })
    bash.handler = () => runResult('a.ts\nb.ts\nc.ts\nd.ts\n')
    const result = await call(ctx, 'glob', { pattern: '*.ts' }, { agent: agent('/w') })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('a.ts\nb.ts\n\n(Showing 2 of 4 paths. Full sorted result stored at: /spill/glob-results.txt. Use the fake retrieval hint.)')
    expect(spill?.saves).toHaveLength(1)
    expect(spill?.saves[0]).toMatchObject({
      owner: { sessionId: 'session-1' },
      source: { toolName: 'glob', label: 'result' },
      suggestedName: 'glob-results.txt',
      content: 'a.ts\nb.ts\nc.ts\nd.ts',
    })
    expect(spill?.saves[0]?.source.callId).toBeDefined()
  })

  it('does not create a spill file when the result fits inline', async () => {
    const { ctx, bash, spill } = await setup({ spill: true })
    bash.handler = () => runResult('a.ts\nb.ts\n')
    const result = await call(ctx, 'glob', { pattern: '*' }, { agent: agent('/w') })
    expect(text(result)).toBe('a.ts\nb.ts')
    expect(spill?.saves).toHaveLength(0)
  })

  it.each([
    ['no spill backend loaded', { fail: false, spill: false, ownerless: false }],
    ['saveText fails', { fail: true, spill: true, ownerless: false }],
    ['no session owner', { fail: false, spill: true, ownerless: true }],
  ])('keeps the inline page and reports the unsaved remainder when %s', async (_label, mode) => {
    const { ctx, bash, spill } = await setup({ config: { globMaxResults: 1 }, spill: mode.spill })
    if (mode.fail && spill) spill.failWith = new Error('disk full')
    bash.handler = () => runResult('a.ts\nb.ts\n')
    const result = await call(ctx, 'glob', { pattern: '*' }, mode.ownerless ? {} : { agent: agent('/w') })
    expect(result.isError).toBe(false) // spill unavailability never fails the search
    expect(text(result)).toBe('a.ts\n\n(Showing 1 of 2 paths. The complete result could not be saved; narrow pattern or path to see more.)')
  })
})

describe('grep results', () => {
  it('groups matches by file with line numbers', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult([
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }),
      matchLine('a.ts', 3, 'const x = 1\n'),
      matchLine('a.ts', 9, 'const y = 2\n'),
      JSON.stringify({ type: 'end', data: { path: { text: 'a.ts' } } }),
      matchLine('b.ts', 1, 'const z = 3'),
      JSON.stringify({ type: 'summary', data: {} }),
      '',
    ].join('\n'))
    const result = await call(ctx, 'grep', { pattern: 'const' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Found 3 matches\n\na.ts\nLine 3: const x = 1\nLine 9: const y = 2\n\nb.ts\nLine 1: const z = 3')
  })

  it('reports a single match in the singular', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult(`${matchLine('a.ts', 1, 'hit')}\n`)
    expect(text(await call(ctx, 'grep', { pattern: 'hit' }))).toBe('Found 1 match\n\na.ts\nLine 1: hit')
  })

  it('relativizes absolute match paths against the resolved workdir', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult(`${matchLine('/sessions/s1/deep/a.ts', 2, 'hit')}\n`)
    const result = await call(ctx, 'grep', { pattern: 'hit', path: '/sessions/s1' }, { agent: agent('/sessions/s1') })
    expect(text(result)).toContain(`${join('deep', 'a.ts')}\nLine 2: hit`)
  })

  it('previews a long matched line at grepMaxLineBytes preserving UTF-8', async () => {
    const { ctx, bash } = await setup({ config: { grepMaxLineBytes: 7 } })
    // 'héllo wörld' cut at 7 bytes lands mid-'é'? h(1)é(2)l(1)l(1)o(1)=6, space=7 → clean cut at 7.
    // Use a multibyte straddle instead: 'aé' repeated — cut at 7 bytes: a(1)é(2)a(1)é(2)=6 +a(1)=7 → next é straddles: trimmed.
    bash.handler = () => runResult(`${matchLine('a.txt', 1, 'aéaéaéaé')}\n`)
    const result = await call(ctx, 'grep', { pattern: 'a' })
    expect(text(result)).toContain('Line 1: aéaéa (line truncated)')
  })

  it('renders a non-UTF-8 line (rg bytes form) as a placeholder instead of failing', async () => {
    const { ctx, bash } = await setup()
    const record = JSON.stringify({ type: 'match', data: { path: { text: 'bin.dat' }, lines: { bytes: 'AAECww==' }, line_number: 4 } })
    bash.handler = () => runResult(`${record}\n`)
    expect(text(await call(ctx, 'grep', { pattern: 'x' }))).toContain('Line 4: (line is not valid UTF-8)')
  })

  it('strips a CRLF terminator from the matched line text', () => {
    const matches = parseGrepMatches(`${matchLine('a.txt', 1, 'windows line\r\n')}\n`)
    expect(matches[0]?.line).toBe('windows line')
  })

  it('caps at grepMaxMatches and spills the full formatted match list', async () => {
    const { ctx, bash, spill } = await setup({ config: { grepMaxMatches: 2 }, spill: true })
    bash.handler = () => runResult([
      matchLine('a.ts', 1, 'one'),
      matchLine('a.ts', 2, 'two'),
      matchLine('b.ts', 3, 'three'),
      '',
    ].join('\n'))
    const result = await call(ctx, 'grep', { pattern: 'e' }, { agent: agent('/w') })
    expect(text(result)).toBe('Found 2 of 3 matches\n\na.ts\nLine 1: one\nLine 2: two\n\n(Full grep result stored at: /spill/grep-results.txt. Use the fake retrieval hint.)')
    expect(spill?.saves[0]).toMatchObject({
      source: { toolName: 'grep', label: 'result' },
      suggestedName: 'grep-results.txt',
      content: 'Found 3 matches\n\na.ts\nLine 1: one\nLine 2: two\n\nb.ts\nLine 3: three',
    })
  })

  it('reports the unsaved remainder when capped with no spill backend', async () => {
    const { ctx, bash } = await setup({ config: { grepMaxMatches: 1 } })
    bash.handler = () => runResult(`${matchLine('a.ts', 1, 'one')}\n${matchLine('a.ts', 2, 'two')}\n`)
    const result = await call(ctx, 'grep', { pattern: 'o' }, { agent: agent('/w') })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Found 1 of 2 matches\n\na.ts\nLine 1: one\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)')
  })

  it('validates arguments (empty pattern, blank path, bad include)', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'grep', { pattern: '' }))).toContain('pattern must be a non-empty string')
    expect(text(await call(ctx, 'grep', { pattern: 'x', path: '  ' }))).toContain('path must be a non-empty string')
    expect(text(await call(ctx, 'grep', { pattern: 'x', include: '  ' }))).toContain('include must be a non-empty glob')
    expect(text(await call(ctx, 'grep', { pattern: 'x', include: '!*.ts' }))).toContain('negated patterns')
    expect(text(await call(ctx, 'grep', { pattern: 'x', include: '*.ts,*.js' }))).toContain('comma-separated list')
  })

  it('accepts a whitespace-only pattern (a legitimate regex) and brace alternation in include', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { exitCode: 1 })
    const result = await call(ctx, 'grep', { pattern: '  ', include: '*.{ts,tsx}' })
    expect(result.isError).toBe(false)
  })
})

describe('rg --json transport failures (SEARCH_FAILED)', () => {
  it.each([
    ['a non-JSON line', 'not json at all'],
    ['a non-object record', '42'],
    ['a match record with no data', JSON.stringify({ type: 'match' })],
    ['a match record with no path text', JSON.stringify({ type: 'match', data: { path: {}, lines: { text: 'x' }, line_number: 1 } })],
    ['a match record with a non-object path', JSON.stringify({ type: 'match', data: { path: 'a.ts', lines: { text: 'x' }, line_number: 1 } })],
    ['a match record with no line number', JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, lines: { text: 'x' } } })],
    ['a match record with no line content', JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, line_number: 1 } })],
    ['a match record with neither text nor bytes', JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, lines: {}, line_number: 1 } })],
  ])('%s fails the search', async (_label, line) => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult(`${line}\n`)
    const result = await call(ctx, 'grep', { pattern: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })
})

describe('the no-background-task invariant', () => {
  it('never calls ctx.bash.start() across successful and failed searches', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('a.ts\n')
    await call(ctx, 'glob', { pattern: '*' })
    bash.handler = () => runResult('', { exitCode: 2, stderr: { text: 'boom', truncated: false } })
    await call(ctx, 'grep', { pattern: 'x' })
    expect(bash.startCalls).toBe(0)
  })
})

describe('presentation', () => {
  it('glob titles carry the pattern and optional root', () => {
    expect(presentGlobCall({ pattern: '**/*.ts' })).toMatchObject({ card: 'generic', title: 'Glob **/*.ts', kind: 'search' })
    expect(presentGlobCall({ pattern: '*.md', path: 'docs' }).title).toBe('Glob *.md in docs')
  })

  it('grep titles carry the pattern, target, and include filter', () => {
    expect(presentGrepCall({ pattern: 'todo' })).toMatchObject({ card: 'generic', title: 'Grep todo', kind: 'search' })
    expect(presentGrepCall({ pattern: 'todo', path: 'src', include: '*.ts' }).title).toBe('Grep todo in src (*.ts)')
  })
})

describe('helpers', () => {
  it('toWorkdirRelative maps inside-workdir absolutes and passes everything else through', () => {
    expect(toWorkdirRelative('/w/a/b.ts', '/w')).toBe(join('a', 'b.ts'))
    expect(toWorkdirRelative('/w', '/w')).toBe('.')
    expect(toWorkdirRelative('/other/b.ts', '/w')).toBe('/other/b.ts')
    expect(toWorkdirRelative('/w-sibling/b.ts', '/w')).toBe('/w-sibling/b.ts')
    expect(toWorkdirRelative('rel/b.ts', '/w')).toBe('rel/b.ts')
    // Normalization makes this land OUTSIDE the workdir → original path kept.
    expect(toWorkdirRelative('/w/../up.ts', '/w')).toBe('/w/../up.ts')
  })

  it('previewLine keeps a within-budget line untouched', () => {
    expect(previewLine('short', 100)).toBe('short')
  })

  it('formatGrepMatches groups by first-seen file order', () => {
    const grouped = formatGrepMatches([
      { path: 'b.ts', lineNumber: 2, line: 'x' },
      { path: 'a.ts', lineNumber: 1, line: 'y' },
      { path: 'b.ts', lineNumber: 5, line: 'z' },
    ])
    expect(grouped).toBe('b.ts\nLine 2: x\nLine 5: z\n\na.ts\nLine 1: y')
  })
})
