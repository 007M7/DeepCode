import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { AgentMessageId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-code-runtime-e2b'
import type {} from '@deepseek-ai/dsh-e2b'
import type {} from '@deepseek-ai/dsh-fs-e2b'
import type {} from '@deepseek-ai/dsh-bash-local'
import type {} from '@deepseek-ai/dsh-lsp-e2b'
import type {} from '@deepseek-ai/dsh-pty-e2b'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('usage: bin.ts <cordis.yml>')

const ctx = await boot('e2b-composition', resolve(configPath))
const ownerFiber = ctx.plugin(() => {})
const ownerId = SessionId('e2b-live-owner')
const owner: Agent = {
  id: ownerId,
  options: {},
  session: new Session(ownerId),
  status: 'idle',
  acceptsNextStep: false,
  ctx: ownerFiber.ctx,
  followup: () => AgentMessageId('unused'),
  steer: () => AgentMessageId('unused'),
  inject: () => AgentMessageId('unused'),
  send: () => AgentMessageId('unused'),
  cancel() {},
  whenIdle: () => Promise.resolve(),
}
const unregisterOwner = ctx.agents.register(owner)
let terminalId: Awaited<ReturnType<typeof ctx.pty.spawn>>['sessionId'] | undefined
try {
  const fromFs = await ctx.fs.resolve('from-fs.txt')
  await ctx.fs.writeText(fromFs, 'written-by-fs\n', { kind: 'createIfAbsent' })
  const bashRead = await ctx.bash.run(ctx.bash.resolve({ command: 'cat from-fs.txt' }))
  if (bashRead.exitCode !== 0 || bashRead.stdout.text !== 'written-by-fs\n') {
    throw new Error(`E2B Bash could not read the FS write: ${JSON.stringify(bashRead)}`)
  }

  const bashWrite = await ctx.bash.run(ctx.bash.resolve({ command: "printf 'written-by-bash\\n' > from-bash.txt" }))
  if (bashWrite.exitCode !== 0) {
    throw new Error(`E2B Bash could not write the shared filesystem: ${JSON.stringify(bashWrite)}`)
  }
  const fromBash = await ctx.fs.resolve('from-bash.txt')
  const fsRead = await ctx.fs.readText(fromBash)

  const environmentHandle = ctx.subprocess.spawn({
    argv: ['env'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {
      'FOO-BAR': 'hyphen-value',
      DSH_EXPLICIT: 'managed-value',
      TOKEN_EXPLICIT: 'credential-value',
    },
  })
  const environmentOutcome = await environmentHandle.done
  const environmentText = environmentHandle.collected.stdout?.readFrom(0).text
  if (environmentOutcome.exitCode !== 0 || environmentText === undefined) {
    throw new Error(`E2B subprocess environment probe failed: ${JSON.stringify(environmentOutcome)}`)
  }
  const environmentLines = new Set(environmentText.trimEnd().split('\n'))
  const explicitEnvironment = [
    'FOO-BAR=hyphen-value',
    'DSH_EXPLICIT=managed-value',
    'TOKEN_EXPLICIT=credential-value',
  ].every(entry => environmentLines.has(entry))
  if (!explicitEnvironment) throw new Error(`E2B subprocess dropped an explicit environment entry: ${environmentText}`)

  const spillHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "printf '0123456789'; sleep 30"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4, spill: { maxBytes: 6 } }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {},
  })
  const spillReader = spillHandle.collected.stdout
  if (spillReader === undefined) throw new Error('E2B subprocess omitted its configured stdout collector')
  const spillDeadline = Date.now() + 5_000
  while (spillReader.readFrom(0).nextOffset < 10) {
    if (Date.now() >= spillDeadline) throw new Error('E2B subprocess did not stream the spill probe output')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  const spillPath = posix.join((spillHandle as unknown as { stateDir: string }).stateDir, 'stdout.log')
  const liveSpillBytes = (await (await ctx.e2b.getSandbox()).files.getInfo(spillPath)).size
  spillHandle.terminate()
  const spillOutcome = await spillHandle.done
  const spillExited = await spillHandle.waitForExit(AbortSignal.timeout(5_000))
  const spillRead = spillReader.readFrom(0)
  if (liveSpillBytes !== 6 || !spillExited || spillRead.spillPath !== undefined) {
    throw new Error(`E2B subprocess spill bound failed: ${JSON.stringify({ liveSpillBytes, spillExited, spillRead })}`)
  }

  const lspFixture = await readFile(new URL('./fixture-lsp.mjs', import.meta.url), 'utf8')
  const remoteLspFixture = await ctx.fs.resolve('fixture-lsp.mjs')
  await ctx.fs.writeText(remoteLspFixture, lspFixture, { kind: 'createIfAbsent' })
  const remoteSource = await ctx.fs.resolve('multibyte # file.ts')
  await ctx.fs.writeText(remoteSource, 'const café = "你好"\nconsole.log(café)\n', { kind: 'createIfAbsent' })
  const hover = await ctx.lsp.query({
    operation: 'hover',
    filePath: 'multibyte # file.ts',
    position: { line: 0, character: 7 },
    workspaceRoot: process.cwd(),
  })
  const definition = await ctx.lsp.query({
    operation: 'goToDefinition',
    filePath: 'multibyte # file.ts',
    position: { line: 0, character: 7 },
    workspaceRoot: process.cwd(),
  })

  const terminal = await ctx.pty.spawn(owner, { type: 'shell' })
  terminalId = terminal.sessionId
  const terminalEcho = await ctx.pty.startSend(owner, terminal.sessionId, {
    text: "printf 'PTY-你好\\n'",
    submit: true,
  }).done
  const sleeping = ctx.pty.startSend(owner, terminal.sessionId, { text: 'sleep 30', submit: true })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  const terminalSignal = await ctx.pty.signal(owner, terminal.sessionId, 'SIGINT')
  const interrupted = await sleeping.done
  const terminalScrollback = ctx.pty.read(owner, terminal.sessionId, { count: 50 })
  await ctx.pty.kill(owner, terminal.sessionId, 'live E2B composition complete')
  terminalId = undefined

  const code = await ctx.codeRuntime.run({
    program: `
      console.log('remote-log 你好', 42)
      const arrayPrototype = Array.prototype
      const objectPrototype = Object.prototype
      const setPrototype = Set.prototype
      const stringPrototype = String.prototype
      Array.isArray = () => false
      Object.defineProperty = Object.getPrototypeOf = Object.keys = () => { throw new Error('mutated object method') }
      Object.hasOwn = () => false
      Object.is = () => true
      objectPrototype.propertyIsEnumerable = () => false
      Number.isFinite = Number.isSafeInteger = () => false
      Reflect.apply = Reflect.ownKeys = () => { throw new Error('mutated reflect method') }
      setPrototype.add = setPrototype.delete = setPrototype.has = () => { throw new Error('mutated set method') }
      stringPrototype.charCodeAt = stringPrototype.codePointAt = stringPrototype.slice = () => { throw new Error('mutated string method') }
      Buffer.byteLength = () => 0
      Function.prototype.toString = () => 'mutated'
      objectPrototype.constructor = arrayPrototype.constructor = null
      globalThis.Array = globalThis.Buffer = globalThis.Function = globalThis.Number = globalThis.Object = globalThis.Promise = globalThis.Reflect = globalThis.Set = globalThis.String = undefined
      process.stdout.write('post-mutation', () => {})
      const doubled: number = await bridge.double({ value: 21 })
      let typed = false
      try {
        await bridge.fail({ reason: 'expected' })
      } catch (error) {
        typed = error instanceof BridgeError && (error as { member: string }).member === 'fail'
      }
      return { doubled, typed }
    `,
    bindings: [{
      global: 'bridge',
      errorClass: { name: 'BridgeError', memberNameProperty: 'member' },
      functions: {
        double: async (args) => {
          const value = (args as { value: number }).value
          return value * 2
        },
        fail: async () => { throw new Error('binding rejected') },
      },
    }],
  })
  const hostileOutput = await ctx.codeRuntime.run({
    program: `
      const payload = '🙂'.repeat(4096)
      String.prototype[Symbol.iterator] = () => { throw new Error('mutated string iterator') }
      console.log(payload)
      return true
    `,
    bindings: [],
  })
  const timedOut = await ctx.codeRuntime.run({
    program: 'await new Promise(() => {})',
    bindings: [],
  })
  const abortController = new AbortController()
  const aborting = ctx.codeRuntime.run({
    program: 'await new Promise(() => {})',
    bindings: [],
    signal: abortController.signal,
  })
  setTimeout(() => { abortController.abort('live abort') }, 50)
  const aborted = await aborting
  const oversizedBoot = await ctx.codeRuntime.run({
    program: `return ${JSON.stringify('x'.repeat(40_000))}`,
    bindings: [],
  })
  const oversizedReply = await ctx.codeRuntime.run({
    program: 'return await bridge.large(null)',
    bindings: [{
      global: 'bridge',
      functions: { large: async () => 'x'.repeat(40_000) },
    }],
  })
  const remoteProcesses = await (await ctx.e2b.getSandbox()).commands.list()
  const lingeringCodeRunners = remoteProcesses.filter(processInfo =>
    JSON.stringify([processInfo.cmd, processInfo.args]).includes('code-runtime-runner.mjs'),
  )

  process.stdout.write(`${JSON.stringify({
    sandboxId: await ctx.e2b.sandboxId,
    bashRead: bashRead.stdout.text,
    fsRead,
    explicitEnvironment,
    spill: { liveBytes: liveSpillBytes, outcome: spillOutcome, read: spillRead },
    hover,
    definition,
    terminal: {
      motd: terminal.motd,
      echo: terminalEcho,
      signal: terminalSignal,
      interrupted,
      scrollback: terminalScrollback.text,
    },
    code,
    hostileOutput,
    timedOut,
    aborted,
    oversizedBoot,
    oversizedReply,
    lingeringCodeRunners: lingeringCodeRunners.length,
  })}\n`)
} finally {
  if (terminalId !== undefined) await ctx.pty.kill(owner, terminalId, 'fixture cleanup').catch(() => false)
  unregisterOwner()
  await ownerFiber.dispose()
  await ctx.fiber.dispose()
}
