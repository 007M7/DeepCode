import { PassThrough } from 'node:stream'
import { Context } from 'cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileType,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'

const mockedLsp = vi.hoisted(() => {
  interface Plan {
    query?: (...args: unknown[]) => unknown
    transportFailure?: unknown
    dead?: boolean
    deadAfterQuery?: boolean
    disposeError?: unknown
  }

  class FakeLspInstance {
    static readonly instances: FakeLspInstance[] = []
    static readonly plans: Plan[] = []
    readonly plan: Plan
    readonly transport: unknown
    readonly queries: unknown[][] = []
    dead: boolean
    disposals = 0

    constructor(
      readonly spec: Record<string, unknown>,
      spawner: (spec: SubprocessSpawnSpec) => unknown,
    ) {
      this.plan = FakeLspInstance.plans.shift() ?? {}
      this.dead = this.plan.dead === true
      this.transport = spawner({
        argv: [String(spec.command), ...(spec.args as string[])],
        cwd: String(spec.cwd),
        env: spec.env as Record<string, string>,
        graceMs: Number(spec.killGraceMs),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: Number(spec.maxStderrBytes) } },
      })
      FakeLspInstance.instances.push(this)
    }

    async query(...args: unknown[]): Promise<unknown> {
      this.queries.push(args)
      const result = await Promise.resolve(this.plan.query?.(...args) ?? { kind: 'hover', hover: null })
      if (this.plan.deadAfterQuery === true) this.dead = true
      return result
    }

    isTransportFailure(error: unknown): boolean {
      return error === this.plan.transportFailure
    }

    async dispose(): Promise<void> {
      this.disposals += 1
      this.dead = true
      if (this.plan.disposeError !== undefined) throw this.plan.disposeError
    }
  }

  return { FakeLspInstance }
})

vi.mock('@deepseek-ai/dsh-lsp-local', () => ({ LspInstance: mockedLsp.FakeLspInstance }))

import {
  E2BLspProvider,
  apply,
  canonicalizeE2BWorkspace,
  e2bFileUri,
  readE2BSource,
} from '@deepseek-ai/dsh-lsp-e2b'
import type { LspE2BServerConfig } from '@deepseek-ai/dsh-lsp-e2b'
import * as E2BLspInvariant from '../src/invariant.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'

class FakeInnerHandle implements SubprocessHandle {
  readonly pid = 777
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }
  readonly done = Promise.resolve({ exitCode: 0, signal: null })
  terminate(): void {}
  async waitForExit(): Promise<boolean> { return true }
}

class FakeRemote {
  readonly writes: Array<Array<{ path: string; data: string }>> = []
  readonly commands: string[] = []
  readonly infos = new Map<string, { type: FileType; size: number }>()
  readonly contents = new Map<string, Uint8Array>()
  readonly realpaths = new Map<string, string>()
  forcedRealpath: string | undefined
  readerResponse: unknown
  readerOutput: string | undefined

  constructor() {
    this.infos.set('/workspace', { type: FileType.DIR, size: 0 })
    this.infos.set('/workspace/file.ts', { type: FileType.FILE, size: 12 })
    this.contents.set('/workspace/file.ts', Buffer.from('const x = 1'))
    this.readerResponse = { kind: 'ok', data: Buffer.from('const x = 1').toString('base64') }
  }

  readonly sandbox = {
    commands: {
      run: async (command: string) => {
        this.commands.push(command)
        if (command.startsWith('realpath ')) {
          const match = /'([^']*)'$/.exec(command)
          const requested = match?.[1] ?? ''
          return { exitCode: 0, stdout: `${this.forcedRealpath ?? this.realpaths.get(requested) ?? requested}\n`, stderr: '' }
        }
        if (command.includes('dsh-e2b-source-reader')) {
          return { exitCode: 0, stdout: this.readerOutput ?? JSON.stringify(this.readerResponse), stderr: '' }
        }
        if (command.startsWith('command -v')) return { exitCode: 0, stdout: '/usr/bin/node\n', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    files: {
      write: async (files: Array<{ path: string; data: string }>) => {
        this.writes.push(files)
        return files.map(() => ({}))
      },
      getInfo: async (path: string) => {
        const info = this.infos.get(path)
        if (info === undefined) throw new Error(`missing info for ${path}`)
        return info
      },
      read: async (path: string) => this.contents.get(path) ?? new Uint8Array(),
    },
  } as unknown as Sandbox
}

function subprocess(spawn = vi.fn((_spec: SubprocessSpawnSpec) => new FakeInnerHandle())): E2BSubprocessService {
  const service = Object.create(E2BSubprocessService.prototype) as E2BSubprocessService
  Object.defineProperty(service, 'spawn', { value: spawn })
  return service
}

function server(overrides: Partial<LspE2BServerConfig> = {}): Required<LspE2BServerConfig> {
  return {
    command: '/usr/bin/server', args: ['--stdio'], env: {},
    extensionToLanguage: { '.ts': 'typescript' },
    initializationOptions: null, configuration: null,
    maxMessageBytes: 1_024, maxStderrBytes: 128, maxDocumentBytes: 1_024,
    shutdownTimeoutMs: 100, killGraceMs: 50,
    ...overrides,
  }
}

function provider(remote = new FakeRemote(), service = subprocess()): E2BLspProvider {
  return new E2BLspProvider(
    'fixture', remote.sandbox, service, server(),
    '/usr/bin/server', '/usr/bin/node', '/workspace/.dsh-e2b/lsp-proxy.mjs',
  )
}

function query(workspaceRoot = '/workspace') {
  return {
    operation: 'hover' as const,
    filePath: 'file.ts',
    position: { line: 0, character: 1 },
    workspaceRoot,
    languageId: 'typescript',
  }
}

beforeEach(() => {
  mockedLsp.FakeLspInstance.instances.length = 0
  mockedLsp.FakeLspInstance.plans.length = 0
})

describe('E2B LSP filesystem boundary', () => {
  it('canonicalizes a directory and reads a contained UTF-8 source', async () => {
    const remote = new FakeRemote()
    await expect(canonicalizeE2BWorkspace(remote.sandbox, '/workspace')).resolves.toBe('/workspace')
    await expect(readE2BSource(remote.sandbox, 'file.ts', '/workspace', 1_024, '/usr/bin/node')).resolves.toEqual({
      canonicalPath: '/workspace/file.ts',
      text: 'const x = 1',
    })
    await expect(readE2BSource(remote.sandbox, '/workspace/file.ts', '/workspace', 1_024, '/usr/bin/node')).resolves.toMatchObject({
      canonicalPath: '/workspace/file.ts',
    })
    const signal = new AbortController().signal
    await expect(canonicalizeE2BWorkspace(remote.sandbox, '/workspace', signal)).resolves.toBe('/workspace')
    await expect(readE2BSource(remote.sandbox, 'file.ts', '/workspace', 1_024, '/usr/bin/node', signal)).resolves.toMatchObject({
      canonicalPath: '/workspace/file.ts',
    })
  })

  it('rejects malformed workspaces and source containment/type/size/encoding failures', async () => {
    const malformed = new FakeRemote()
    malformed.forcedRealpath = 'relative'
    await expect(canonicalizeE2BWorkspace(malformed.sandbox, '/workspace')).rejects.toThrow('did not resolve canonically')
    malformed.forcedRealpath = '/workspace\nother'
    await expect(canonicalizeE2BWorkspace(malformed.sandbox, '/workspace')).rejects.toThrow('did not resolve canonically')

    const notDirectory = new FakeRemote()
    notDirectory.infos.set('/workspace', { type: FileType.FILE, size: 0 })
    await expect(canonicalizeE2BWorkspace(notDirectory.sandbox, '/workspace')).rejects.toThrow('not a directory')

    const outside = new FakeRemote()
    outside.realpaths.set('/workspace/file.ts', '/outside/file.ts')
    await expect(readE2BSource(outside.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('outside the workspace')

    const notFile = new FakeRemote()
    notFile.readerResponse = { kind: 'not-file' }
    await expect(readE2BSource(notFile.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('not a regular file')

    const tooLarge = new FakeRemote()
    tooLarge.readerResponse = { kind: 'oversize', size: 21 }
    await expect(readE2BSource(tooLarge.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('over the 20-byte limit')

    const grew = new FakeRemote()
    grew.readerResponse = { kind: 'grew' }
    await expect(readE2BSource(grew.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('grew past')

    const invalid = new FakeRemote()
    invalid.readerResponse = { kind: 'ok', data: Buffer.from([0xff]).toString('base64') }
    await expect(readE2BSource(invalid.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('not valid UTF-8')

    const swapped = new FakeRemote()
    swapped.readerResponse = { kind: 'open-error', message: 'ELOOP: symbolic link encountered' }
    await expect(readE2BSource(swapped.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('opened safely')

    const malformedReader = new FakeRemote()
    malformedReader.readerResponse = { kind: 'ok', data: '*' }
    await expect(readE2BSource(malformedReader.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('invalid bounded bytes')
    malformedReader.readerResponse = { kind: 'oversize', size: 'large' }
    await expect(readE2BSource(malformedReader.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('invalid response')
    malformedReader.readerOutput = '{'
    await expect(readE2BSource(malformedReader.sandbox, 'file.ts', '/workspace', 20, '/usr/bin/node')).rejects.toThrow('invalid response')

    await expect(canonicalizeE2BWorkspace(new FakeRemote().sandbox, '/workspace', AbortSignal.abort('stop')))
      .rejects.toBe('stop')
  })
})

describe('E2BLspProvider pooling and lifecycle', () => {
  it('reuses one canonical-workspace instance and constructs the remote proxy transport', async () => {
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => new FakeInnerHandle())
    const remote = new FakeRemote()
    mockedLsp.FakeLspInstance.plans.push({ query: async () => ({ kind: 'hover', hover: { contents: 'ok' } }) })
    const current = provider(remote, subprocess(spawn))

    await expect(current.query(query())).resolves.toEqual({ kind: 'hover', hover: { contents: 'ok' } })
    await expect(current.query(query())).resolves.toEqual({ kind: 'hover', hover: { contents: 'ok' } })
    expect(mockedLsp.FakeLspInstance.instances).toHaveLength(1)
    expect(mockedLsp.FakeLspInstance.instances[0]?.spec).toMatchObject({ clientProcessId: null, cwd: '/workspace' })
    expect(e2bFileUri('/workspace/a b#c.ts')).toBe('file:///workspace/a%20b%23c.ts')
    expect(() => e2bFileUri('relative.ts')).toThrow('absolute remote path')
    const pathToFileUri = mockedLsp.FakeLspInstance.instances[0]?.spec.pathToFileUri as (path: string) => string
    expect(pathToFileUri('/workspace/a b#c.ts')).toBe('file:///workspace/a%20b%23c.ts')
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/usr/bin/node', '/workspace/.dsh-e2b/lsp-proxy.mjs', expect.any(String)],
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 128 } },
    }))
    expect(current.id).toBe('fixture')
    expect(current.extensionToLanguage).toEqual({ '.ts': 'typescript' })
    await current.disposeAll()
    expect(mockedLsp.FakeLspInstance.instances[0]?.disposals).toBe(1)
  })

  it('replaces one transport failure, but preserves ordinary query errors', async () => {
    const transportFailure = new Error('transport failed')
    mockedLsp.FakeLspInstance.plans.push(
      { transportFailure, query: async () => { throw transportFailure } },
      { query: async () => ({ kind: 'hover', hover: { contents: 'retried' } }) },
    )
    const retried = provider()
    await expect(retried.query(query())).resolves.toMatchObject({ hover: { contents: 'retried' } })
    expect(mockedLsp.FakeLspInstance.instances[0]?.disposals).toBe(1)
    expect(mockedLsp.FakeLspInstance.instances).toHaveLength(2)

    const ordinary = new Error('ordinary failure')
    mockedLsp.FakeLspInstance.plans.push(
      { query: async () => { throw ordinary }, dead: true },
      { query: async () => ({ kind: 'hover', hover: null }) },
    )
    const failed = provider()
    await expect(failed.query(query())).rejects.toBe(ordinary)
    await expect(failed.query(query())).resolves.toMatchObject({ kind: 'hover' })
  })

  it('evicts a server that dies after a successful query', async () => {
    mockedLsp.FakeLspInstance.plans.push(
      { deadAfterQuery: true, query: async () => ({ kind: 'hover', hover: null }) },
      { query: async () => ({ kind: 'hover', hover: null }) },
    )
    const current = provider()
    await current.query(query())
    await current.query(query())
    expect(mockedLsp.FakeLspInstance.instances).toHaveLength(2)
    expect(mockedLsp.FakeLspInstance.instances[0]?.disposals).toBe(1)
  })

  it('serializes a workspace queue, observes queued abort, and awaits work on disposal', async () => {
    const first = Promise.withResolvers<unknown>()
    mockedLsp.FakeLspInstance.plans.push({ query: () => first.promise })
    const current = provider()
    const running = current.query(query())
    const controller = new AbortController()
    const queued = current.query(query(), controller.signal)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort('queued stop')
    await expect(queued).rejects.toBe('queued stop')

    const disposing = current.disposeAll()
    first.resolve({ kind: 'hover', hover: null })
    await expect(running).resolves.toMatchObject({ kind: 'hover' })
    await disposing
    await expect(current.query(query())).rejects.toMatchObject({ code: 'LSP_DISPOSED' })
  })

  it('covers pre-abort, synthetic abort, resolve, and rejection in the queue race', async () => {
    const current = provider()
    const internal = current as unknown as {
      queues: Map<string, Promise<void>>
      enqueue<T>(workspace: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T>
    }
    await expect(internal.enqueue('pre', AbortSignal.abort('pre-stop'), async () => 'unused')).rejects.toBe('pre-stop')

    const signal = new AbortController().signal
    await expect(internal.enqueue('resolve', signal, async () => 'ok')).resolves.toBe('ok')

    const failure = new Error('queue failed')
    const rejected = Promise.reject<undefined>(failure)
    void rejected.catch(() => {})
    internal.queues.set('reject', rejected)
    await expect(internal.enqueue('reject', signal, async () => 'unused')).rejects.toBe(failure)

    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise normalization at the promise boundary.
    const opaque = Promise.reject<undefined>('opaque queue failure')
    void opaque.catch(() => {})
    internal.queues.set('opaque', opaque)
    await expect(internal.enqueue('opaque', signal, async () => 'unused')).rejects.toEqual(new Error('opaque queue failure'))

    const synthetic = {
      aborted: false,
      reason: undefined,
      throwIfAborted() {},
      addEventListener(_type: string, listener: () => void) { listener() },
      removeEventListener() {},
    } as unknown as AbortSignal
    await expect(internal.enqueue('synthetic', synthetic, async () => 'unused')).rejects.toMatchObject({ name: 'AbortError' })
    await current.disposeAll()
  })
})

describe('lsp-e2b plugin composition', () => {
  function pluginContext(
    remote: FakeRemote,
    service: E2BSubprocessService,
    registerProvider = vi.fn(() => vi.fn()),
  ) {
    const effects: Array<() => void | Promise<void>> = []
    const ctx = {
      subprocess: service,
      e2b: {
        runtimeRoot: '/workspace/.dsh-e2b',
        getSandbox: async () => remote.sandbox,
      },
      lsp: { registerProvider },
      effect: (callback: () => (() => void | Promise<void>)) => { effects.push(callback()) },
    } as unknown as Context
    return { ctx, effects, registerProvider }
  }

  it('installs one proxy, resolves commands, registers providers, and disposes them', async () => {
    const remote = new FakeRemote()
    const fixture = pluginContext(remote, subprocess())
    await apply(fixture.ctx, { servers: { one: server(), two: server({ command: 'server-two' }) } })
    expect(remote.writes).toHaveLength(1)
    expect(remote.writes[0]?.[0]?.path).toBe('/workspace/.dsh-e2b/lsp-stdio-proxy.mjs')
    expect(remote.commands).toContain("chmod 600 -- '/workspace/.dsh-e2b/lsp-stdio-proxy.mjs'")
    expect(fixture.registerProvider).toHaveBeenCalledTimes(2)
    await fixture.effects[0]?.()
  })

  it('rolls back partial registration and rejects invalid composition/configuration', async () => {
    const remote = new FakeRemote()
    const firstDispose = vi.fn()
    const register = vi.fn()
      .mockReturnValueOnce(firstDispose)
      .mockImplementationOnce(() => { throw new Error('duplicate provider') })
    const rollback = pluginContext(remote, subprocess(), register)
    await expect(apply(rollback.ctx, { servers: { one: server(), two: server() } })).rejects.toThrow('duplicate provider')
    expect(firstDispose).toHaveBeenCalledOnce()

    const wrong = pluginContext(remote, {} as E2BSubprocessService)
    await expect(apply(wrong.ctx, { servers: { one: server() } })).rejects.toThrow('dsh-subprocess-e2b')

    const empty = pluginContext(remote, subprocess())
    await expect(apply(empty.ctx, { servers: {} })).rejects.toThrow('at least one server')

    for (const [id, config] of [
      ['', server()],
      ['one', server({ command: '' })],
      ['one', server({ maxMessageBytes: 0 })],
      ['one', server({ maxStderrBytes: 1.5 })],
      ['one', server({ shutdownTimeoutMs: 2_147_483_648 })],
    ] as const) {
      const fixture = pluginContext(new FakeRemote(), subprocess())
      await expect(apply(fixture.ctx, { servers: { [id]: config } })).rejects.toThrow()
    }
  })

  it('registers the package-owned invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = await ctx.plugin(E2BLspInvariant).await()
    await fiber.dispose()
  })
})
