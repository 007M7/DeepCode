/** E2B filesystem and process backend for the harness LSP capability seam. */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  FileType,
  quoteE2BShellArg,
  resolveE2BExecutable,
} from '@deepseek-ai/dsh-e2b'
import type { Sandbox } from '@deepseek-ai/dsh-e2b'
import { LspError, LspProviderId } from '@deepseek-ai/dsh-lsp'
import type { LspProvider, LspProviderQuery, LspQueryResult } from '@deepseek-ai/dsh-lsp'
import { LspInstance } from '@deepseek-ai/dsh-lsp-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessService from '@deepseek-ai/dsh-subprocess-e2b'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { LSP_PROXY_SOURCE } from './proxy-source.ts'
import { E2BLspTransport } from './transport.ts'

export { E2BLspTransport } from './transport.ts'

/** Cordis plugin name. */
export const name = 'lsp-e2b'
/** Services required by the remote provider. */
export const inject = ['e2b', 'lsp', 'subprocess']

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000

/* jscpd:ignore-start -- Loader requires each backend to expose its own statically walkable server schema. */
/** One configured language server inside the shared E2B sandbox. */
export interface LspE2BServerConfig {
  /** Remote executable, absolute or resolved on the sandbox PATH. */
  command: string
  /** Lowercase leading-dot extension to LSP language id. */
  extensionToLanguage: Record<string, string>
  /** Remote executable arguments. */
  args?: string[]
  /** Explicit remote environment overrides. */
  env?: Record<string, string>
  /** Static `initialize` options. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. */
  configuration?: unknown
  /** Largest LSP message accepted from the server. */
  maxMessageBytes?: number
  /** Largest remote stderr tail retained for diagnostics. */
  maxStderrBytes?: number
  /** Largest remote source opened for one query. */
  maxDocumentBytes?: number
  /** Graceful LSP shutdown budget. */
  shutdownTimeoutMs?: number
  /** Request-cancel and TERM-to-KILL grace. */
  killGraceMs?: number
}

/** Plugin configuration. */
export interface Config {
  /** Non-empty provider-id to remote-server table. */
  servers: Record<string, LspE2BServerConfig>
}

type ResolvedServerConfig = Required<LspE2BServerConfig>

const ServerConfig: z<LspE2BServerConfig> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
})

/** Schemastery plugin configuration. */
export const Config: z<Config> = z.object({
  servers: z.dict(ServerConfig).required(),
})
/* jscpd:ignore-end */

interface RemoteSource {
  canonicalPath: string
  text: string
}

function abortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted()
  } catch (error: unknown) {
    return error
  }
  return new DOMException('The operation was aborted', 'AbortError')
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  // AbortSignal permits opaque reasons, and callers observe the exact reason.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the signal's exact opaque reason.
      reject(abortReason(signal))
    }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

function validateServerConfig(providerId: string, config: ResolvedServerConfig): void {
  if (config.command.length === 0) throw new Error(`lsp-e2b: servers.${providerId}.command must be non-empty`)
  for (const name of ['maxMessageBytes', 'maxStderrBytes', 'maxDocumentBytes', 'shutdownTimeoutMs', 'killGraceMs'] as const) {
    const value = config[name]
    if (!Number.isSafeInteger(value) || value <= 0 || (name.endsWith('Ms') && value > MAX_TIMER_DELAY_MS)) {
      throw new Error(`lsp-e2b: servers.${providerId}.${name} must be a positive safe integer${name.endsWith('Ms') ? ` no greater than ${MAX_TIMER_DELAY_MS}` : ''}`)
    }
  }
}

async function canonicalRemotePath(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const result = await sandbox.commands.run(`realpath -e -- ${quoteE2BShellArg(path)}`, signal === undefined ? {} : { signal })
  signal?.throwIfAborted()
  const canonical = result.stdout.trim()
  if (!posix.isAbsolute(canonical) || canonical.includes('\n')) throw new Error(`remote path ${JSON.stringify(path)} did not resolve canonically`)
  return canonical
}

/**
 * Canonicalize and validate one workspace inside E2B.
 * @param sandbox - Shared sandbox that owns the workspace.
 * @param workspaceRoot - Remote workspace path supplied by the query.
 * @param signal - Optional query cancellation signal.
 * @returns The canonical remote directory path.
 */
export async function canonicalizeE2BWorkspace(
  sandbox: Sandbox,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const canonical = await canonicalRemotePath(sandbox, workspaceRoot, signal)
  const info = await sandbox.files.getInfo(canonical, signal === undefined ? {} : { signal })
  signal?.throwIfAborted()
  if (info.type !== FileType.DIR) throw new Error(`workspace root ${JSON.stringify(workspaceRoot)} is not a directory`)
  return canonical
}

/**
 * Resolve, contain, and read one UTF-8 query source inside E2B.
 * @param sandbox - Shared sandbox that owns the source.
 * @param filePath - Absolute path or path relative to the canonical workspace.
 * @param workspace - Canonical remote workspace directory.
 * @param maxDocumentBytes - Maximum source size before and after reading.
 * @param signal - Optional query cancellation signal.
 * @returns The canonical source path and decoded text.
 */
export async function readE2BSource(
  sandbox: Sandbox,
  filePath: string,
  workspace: string,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<RemoteSource> {
  const requested = posix.isAbsolute(filePath) ? filePath : posix.resolve(workspace, filePath)
  const canonicalPath = await canonicalRemotePath(sandbox, requested, signal)
  const relative = posix.relative(workspace, canonicalPath)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
    throw new Error(`source ${JSON.stringify(filePath)} resolves outside the workspace`)
  }
  const info = await sandbox.files.getInfo(canonicalPath, signal === undefined ? {} : { signal })
  if (info.type !== FileType.FILE) throw new Error(`source ${JSON.stringify(filePath)} is not a regular file`)
  if (info.size > maxDocumentBytes) {
    throw new Error(`source ${JSON.stringify(filePath)} is ${info.size} bytes, over the ${maxDocumentBytes}-byte limit`)
  }
  const bytes = await sandbox.files.read(canonicalPath, { format: 'bytes', ...signal === undefined ? {} : { signal } })
  signal?.throwIfAborted()
  if (bytes.length > maxDocumentBytes) {
    throw new Error(`source ${JSON.stringify(filePath)} grew past the ${maxDocumentBytes}-byte limit while reading`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new Error(`source ${JSON.stringify(filePath)} is not valid UTF-8 text`, { cause: error })
  }
  return { canonicalPath, text }
}

/* jscpd:ignore-start -- Provider identity mirrors the seam while remote source and process ownership stay local. */
/** One pooled remote provider with an isolated server per canonical workspace. */
export class E2BLspProvider implements LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  private readonly instances = new Map<string, LspInstance>()
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    providerId: string,
    private readonly sandbox: Sandbox,
    private readonly subprocess: E2BSubprocessService,
    private readonly config: ResolvedServerConfig,
    private readonly executable: string,
    private readonly nodeExecutable: string,
    private readonly proxyPath: string,
  ) {
    this.id = LspProviderId(providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }
  /* jscpd:ignore-end */

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    this.assertActive(signal)
    const workspace = await canonicalizeE2BWorkspace(this.sandbox, request.workspaceRoot, signal)
    this.assertActive(signal)
    return this.enqueue(workspace, signal, async () => {
      this.assertActive(signal)
      const source = await readE2BSource(this.sandbox, request.filePath, workspace, this.config.maxDocumentBytes, signal)
      this.assertActive(signal)
      let instance = this.instanceFor(workspace)
      try {
        return await instance.query(request, source, signal)
      } catch (error: unknown) {
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evict(workspace, instance)
        this.assertActive(signal)
        instance = this.instanceFor(workspace)
        return await instance.query(request, source, signal)
      } finally {
        if (instance.dead) {
          await instance.dispose()
          this.evict(workspace, instance)
        }
      }
    })
  }

  /* jscpd:ignore-start -- Queue and pooling semantics are shared; transport failure and disposal identities differ. */
  /** Stop accepting work and await every remote server and queued query. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const instances = [...this.instances.values()]
    const queues = [...this.queues.values()]
    this.instances.clear()
    await Promise.all([...instances.map(instance => instance.dispose()), ...queues])
    this.queues.clear()
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.disposed) throw new LspError('lsp-e2b provider is disposed', 'LSP_DISPOSED')
    signal?.throwIfAborted()
  }

  private enqueue<T>(workspace: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.queues.set(workspace, tail)
    void tail.then(() => { if (this.queues.get(workspace) === tail) this.queues.delete(workspace) })
    return result
  }

  private instanceFor(workspace: string): LspInstance {
    this.assertActive()
    const existing = this.instances.get(workspace)
    if (existing !== undefined) return existing
    const created = this.createInstance(workspace)
    this.instances.set(workspace, created)
    return created
  }
  /* jscpd:ignore-end */

  private createInstance(workspace: string): LspInstance {
    return new LspInstance({
      command: this.executable,
      args: this.config.args,
      cwd: workspace,
      env: this.config.env,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
      clientProcessId: null,
    }, (spec: SubprocessSpawnSpec) => {
      const originalArgv = Buffer.from(JSON.stringify(spec.argv)).toString('base64')
      const inner = this.subprocess.spawn({
        ...spec,
        argv: [this.nodeExecutable, this.proxyPath, originalArgv],
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: this.config.maxStderrBytes },
        },
      })
      const rawBound = Math.max(this.config.maxMessageBytes, this.config.maxStderrBytes)
      return new E2BLspTransport(inner, rawBound * 2 + 1024, this.config.maxStderrBytes)
    })
  }

  private evict(workspace: string, instance: LspInstance): void {
    if (this.instances.get(workspace) === instance) this.instances.delete(workspace)
  }
}

/** Install the proxy, resolve remote commands, and atomically register providers. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!(ctx.subprocess instanceof E2BSubprocessService)) {
    throw new Error('lsp-e2b requires @deepseek-ai/dsh-subprocess-e2b as ctx.subprocess')
  }
  const subprocess = ctx.subprocess
  const entries = Object.entries(config.servers)
  if (entries.length === 0) throw new Error('lsp-e2b: servers must contain at least one server')
  const sandbox = await ctx.e2b.getSandbox()
  const proxyPath = posix.join(ctx.e2b.runtimeRoot, 'lsp-stdio-proxy.mjs')
  await sandbox.files.write([{ path: proxyPath, data: LSP_PROXY_SOURCE }])
  await sandbox.commands.run(`chmod 600 -- ${quoteE2BShellArg(proxyPath)}`)
  const nodeExecutable = await resolveE2BExecutable(sandbox, 'node')
  const providers = await Promise.all(entries.map(async ([providerId, raw]) => {
    if (providerId.trim() === '') throw new Error('lsp-e2b: server ids must be non-empty strings')
    const resolved = raw as ResolvedServerConfig
    validateServerConfig(providerId, resolved)
    const executable = await resolveE2BExecutable(sandbox, resolved.command)
    return new E2BLspProvider(providerId, sandbox, subprocess, resolved, executable, nodeExecutable, proxyPath)
  }))

  /* jscpd:ignore-start -- Every provider table publishes atomically through the same registry contract. */
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const provider of providers) disposers.push(ctx.lsp.registerProvider(provider))
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      await Promise.all(providers.map(provider => provider.disposeAll()))
    }
  }, 'lsp-e2b.registerProviders')
  /* jscpd:ignore-end */
}
