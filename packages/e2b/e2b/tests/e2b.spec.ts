import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { Sandbox as SandboxType } from 'e2b'
import E2BSandboxService, {
  E2BSandboxId,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import * as E2BInvariant from '../src/invariant.ts'
import InvariantService from '@deepseek-ai/dsh-invariants'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
}))

vi.mock('e2b', async (importOriginal) => {
  const actual = await importOriginal<typeof import('e2b')>()
  // The mock replaces only the SDK's static factory surface and is never constructed.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class FakeSandbox {
    static create(...args: unknown[]): unknown {
      return sdk.create(...args)
    }

    static connect(...args: unknown[]): unknown {
      return sdk.connect(...args)
    }
  }
  return { ...actual, Sandbox: FakeSandbox }
})

interface SandboxFixture {
  sandbox: SandboxType
  makeDir: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
}

function fakeSandbox(id = 'sandbox-1'): SandboxFixture {
  const makeDir = vi.fn().mockResolvedValue(true)
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  const kill = vi.fn().mockResolvedValue(undefined)
  const pause = vi.fn().mockResolvedValue(true)
  const sandbox = {
    sandboxId: id,
    files: { makeDir },
    commands: { run },
    kill,
    pause,
  } as unknown as SandboxType
  return { sandbox, makeDir, run, kill, pause }
}

beforeEach(() => {
  sdk.create.mockReset()
  sdk.connect.mockReset()
  vi.unstubAllEnvs()
})

describe('E2BSandboxService', () => {
  it('creates one protected shared sandbox and kills it on default disposal', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, { apiKey: 'test-key' })

    const service = ctx.e2b
    await expect(service.getSandbox()).resolves.toBe(fixture.sandbox)
    await expect(service.sandboxId).resolves.toBe(E2BSandboxId('sandbox-1'))
    expect(service.cwd).toBe('/home/user/workspace')
    expect(service.runtimeRoot).toBe('/home/user/workspace/.dsh-e2b')
    expect(service.created).toBe(true)
    expect(service.timeoutMode).toBe('pause')
    expect(service.disposeMode).toBe('kill')
    expect(sdk.create).toHaveBeenCalledWith({
      apiKey: 'test-key',
      timeoutMs: 300_000,
      secure: true,
      lifecycle: { onTimeout: 'pause', autoResume: true },
    })
    expect(fixture.makeDir).toHaveBeenNthCalledWith(1, '/home/user/workspace')
    expect(fixture.makeDir).toHaveBeenNthCalledWith(2, '/home/user/workspace/.dsh-e2b')
    expect(fixture.run).toHaveBeenCalledWith("chmod 700 -- '/home/user/workspace/.dsh-e2b'")

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    await expect(service.getSandbox()).rejects.toThrow(/disposing/)
  })

  it('rejects handle acquisition when disposal starts during setup', async () => {
    const fixture = fakeSandbox()
    const opening = Promise.withResolvers<SandboxType>()
    sdk.create.mockReturnValue(opening.promise)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, { apiKey: 'test-key' })

    const acquisition = ctx.e2b.getSandbox()
    const disposing = fiber.dispose()
    opening.resolve(fixture.sandbox)

    await expect(acquisition).rejects.toThrow(/disposing/)
    await expect(disposing).resolves.toBeUndefined()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('creates from a template, honors timeout and pause policies, and reads the key from the environment', async () => {
    vi.stubEnv('E2B_API_KEY', 'environment-key')
    const fixture = fakeSandbox('template-sandbox')
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, {
      template: 'agent-template',
      cwd: '/workspace/project',
      timeoutMs: 60_000,
      onTimeout: 'kill',
      onDispose: 'pause',
    })
    await ctx.e2b.getSandbox()

    expect(sdk.create).toHaveBeenCalledWith('agent-template', {
      apiKey: 'environment-key',
      timeoutMs: 60_000,
      secure: true,
      lifecycle: { onTimeout: 'kill', autoResume: false },
    })
    await fiber.dispose()
    expect(fixture.pause).toHaveBeenCalledOnce()
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('accepts an already-paused result during configured pause disposal', async () => {
    const fixture = fakeSandbox()
    fixture.pause.mockResolvedValue(false)
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, { apiKey: 'test-key', onDispose: 'pause' })
    await ctx.e2b.getSandbox()
    await fiber.dispose()
    expect(fixture.pause).toHaveBeenCalledOnce()
  })

  it('reconnects without applying creation lifecycle options and can leave state running', async () => {
    const fixture = fakeSandbox('existing')
    sdk.connect.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, {
      apiKey: 'test-key',
      sandboxId: 'existing',
      timeoutMs: 90_000,
      onDispose: 'leave',
    })
    await ctx.e2b.getSandbox()

    expect(ctx.e2b.created).toBe(false)
    expect(sdk.connect).toHaveBeenCalledWith('existing', { apiKey: 'test-key', timeoutMs: 90_000 })
    expect(sdk.create).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(fixture.pause).not.toHaveBeenCalled()
  })

  it('kills a newly created sandbox when remote directory setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.makeDir.mockRejectedValueOnce(new Error('setup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BSandboxService, { apiKey: 'test-key' })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('setup failed')
    await expect(ctx.e2b.sandboxId).rejects.toThrow('setup failed')
    expect(fixture.kill).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('preserves the setup failure even when cleanup also fails', async () => {
    const fixture = fakeSandbox()
    fixture.run.mockRejectedValueOnce(new Error('chmod failed'))
    fixture.kill.mockRejectedValueOnce(new Error('cleanup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    await ctx.plugin(E2BSandboxService, { apiKey: 'test-key' })
    await expect(ctx.e2b.getSandbox()).rejects.toThrow('chmod failed')
  })

  it('does not kill a reconnected sandbox when setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.makeDir.mockRejectedValueOnce(new Error('setup failed'))
    sdk.connect.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    await ctx.plugin(E2BSandboxService, { apiKey: 'test-key', sandboxId: 'existing' })
    await expect(ctx.e2b.getSandbox()).rejects.toThrow('setup failed')
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it.each([
    [{ apiKey: '' }, /configure apiKey/],
    [{ apiKey: 'x', cwd: 'relative' }, /absolute Linux path/],
    [{ apiKey: 'x', timeoutMs: 0 }, /positive finite/],
    [{ apiKey: 'x', sandboxId: '' }, /sandboxId must be non-empty/],
    [{ apiKey: 'x', sandboxId: 'one', template: 'two' }, /template applies only/],
  ] as const)('fails self-contained configuration before opening E2B: %j', async (config, message) => {
    vi.stubEnv('E2B_API_KEY', '')
    const ctx = new Context()
    await expect(ctx.plugin(E2BSandboxService, config)).rejects.toThrow(message)
    expect(sdk.create).not.toHaveBeenCalled()
    expect(sdk.connect).not.toHaveBeenCalled()
  })

  it('requires a key when both config and the environment omit it', async () => {
    const original = process.env.E2B_API_KEY
    delete process.env.E2B_API_KEY
    try {
      const ctx = new Context()
      await expect(ctx.plugin(E2BSandboxService, {})).rejects.toThrow(/configure apiKey/)
    } finally {
      if (original === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = original
    }
  })
})

describe('E2B helpers and invariant companion', () => {
  it('quotes opaque shell arguments without interpolation', () => {
    expect(quoteE2BShellArg("a'b $HOME")).toBe("'a'\"'\"'b $HOME'")
  })

  it('registers the package-owned empty invariant installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    const fiber = await ctx.plugin(E2BInvariant).await()
    await fiber.dispose()
  })
})
