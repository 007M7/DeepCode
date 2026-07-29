import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-code-runtime-subprocess'
import { quoteE2BShellArg } from '@deepseek-ai/dsh-e2b'
import type {} from '@deepseek-ai/dsh-fs-e2b'
import type {} from '@deepseek-ai/dsh-bash-local'
import type {} from '@deepseek-ai/dsh-lsp-local'
import type {} from '@deepseek-ai/dsh-pty-local'

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
  followup() {},
  steer() {},
  inject() {},
  send() {},
  cancel() {},
  whenIdle: () => Promise.resolve(),
}
const unregisterOwner = ctx.agents.register(owner)
let terminalId: Awaited<ReturnType<typeof ctx.pty.spawn>>['sessionId'] | undefined
try {
  const sandbox = await ctx.e2b.getSandbox()
  const fromFs = await ctx.fs.resolve('from-fs.txt')
  const written = await ctx.fs.writeText(fromFs, 'written-by-fs\n', { kind: 'createIfAbsent' })
  const reread = await ctx.fs.stat(fromFs)
  if (reread?.version !== written.version) {
    throw new Error(`E2B rename did not preserve version metadata: ${JSON.stringify({ written, reread })}`)
  }
  await ctx.fs.editText(
    fromFs,
    { oldString: 'written-by-fs', newString: 'written-by-fs-versioned', replaceAll: false },
    { version: reread.version },
  )
  const fsVersionGuard = true
  const bashRead = await ctx.bash.run(ctx.bash.resolve({ command: 'cat from-fs.txt' }))
  if (bashRead.exitCode !== 0 || bashRead.stdout.text !== 'written-by-fs-versioned\n') {
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

  const splitUtf8Handle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "printf '\\344'; sleep 0.05; printf '\\275'; sleep 0.05; printf '\\240'; sleep 0.05; printf '\\345'; sleep 0.05; printf '\\245'; sleep 0.05; printf '\\275'"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {},
  })
  const splitUtf8Outcome = await splitUtf8Handle.done
  const splitUtf8Output = splitUtf8Handle.collected.stdout?.readFrom(0).text
  if (splitUtf8Outcome.exitCode !== 0 || splitUtf8Output !== '你好') {
    throw new Error(`E2B subprocess corrupted split UTF-8 output: ${JSON.stringify({ splitUtf8Outcome, splitUtf8Output })}`)
  }

  const outputDrainStarted = Date.now()
  const outputDrainHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "bash -c 'exec -a dsh-output-drain-descendant sleep 30' & printf 'leader-done\\n'"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 4_096 } },
    graceMs: 250,
    env: {},
  })
  const outputDrainOutcome = await outputDrainHandle.done
  const outputDrainText = outputDrainHandle.collected.stdout?.readFrom(0).text
  const outputDrainElapsedMs = Date.now() - outputDrainStarted
  outputDrainHandle.terminate()
  const outputDrainExited = await outputDrainHandle.waitForExit(AbortSignal.timeout(5_000))
  const outputDrainProcesses = await sandbox.commands.list()
  const outputDrainClean = !outputDrainProcesses.some(processInfo =>
    JSON.stringify([processInfo.cmd, processInfo.args]).includes('dsh-output-drain-descendant'),
  )
  if (outputDrainOutcome.exitCode !== 0 || outputDrainText !== 'leader-done\n'
    || outputDrainElapsedMs >= 10_000 || !outputDrainExited || !outputDrainClean) {
    throw new Error(`E2B subprocess output drain was not bounded: ${JSON.stringify({
      outputDrainOutcome, outputDrainText, outputDrainElapsedMs, outputDrainExited, outputDrainClean,
    })}`)
  }

  const remoteFiles = sandbox.files as unknown as {
    read(path: string, options?: unknown): Promise<unknown>
  }
  const readRemoteFile = remoteFiles.read.bind(sandbox.files)
  let publicationFaultInjected = false
  remoteFiles.read = async (path, options) => {
    if (!publicationFaultInjected && path.includes('/processes/') && path.endsWith('/pid')) {
      publicationFaultInjected = true
      throw new Error('injected process-group publication read failure')
    }
    return await readRemoteFile(path, options)
  }
  let publicationRollback = false
  try {
    const unpublished = ctx.subprocess.spawn({
      argv: ['bash', '-c', 'exec -a dsh-publication-survivor sleep 30 & wait'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
      graceMs: 500,
      env: {},
    })
    await unpublished.done
    throw new Error('E2B subprocess unexpectedly survived an injected publication failure')
  } catch (error: unknown) {
    if (!String(error).includes('injected process-group publication read failure')) throw error
    const processes = await sandbox.commands.run('ps -eo args=')
    publicationRollback = publicationFaultInjected && !processes.stdout.includes('dsh-publication-survivor')
    if (!publicationRollback) throw new Error('E2B subprocess publication rollback left its remote process group alive')
  } finally {
    remoteFiles.read = readRemoteFile
  }

  const spillHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "printf '0123456789'; sleep 30"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4, spill: { maxBytes: 6 } }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {},
  })
  const spillReader = spillHandle.collected.stdout
  if (spillReader === undefined) throw new Error('E2B subprocess omitted its configured stdout collector')
  const spillDeadline = Date.now() + 15_000
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

  const oversizedSourcePath = posix.join(process.cwd(), 'oversized-source.ts')
  await sandbox.commands.run(`head -c 4000001 /dev/zero | tr '\\0' x > ${quoteE2BShellArg(oversizedSourcePath)}`)
  let lspDocumentBound = false
  try {
    await ctx.lsp.query({
      operation: 'hover',
      filePath: 'oversized-source.ts',
      position: { line: 0, character: 0 },
      workspaceRoot: process.cwd(),
    })
  } catch (error: unknown) {
    lspDocumentBound = String(error).includes('exceeds the 4000000-byte limit')
    if (!lspDocumentBound) throw error
  }
  if (!lspDocumentBound) throw new Error('E2B LSP accepted an oversized remote source')

  const remoteCommands = sandbox.commands as unknown as {
    run(command: string, options?: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
  const runRemoteCommand = remoteCommands.run.bind(sandbox.commands)
  const terminal = await ctx.pty.spawn(owner, { type: 'shell' })
  terminalId = terminal.sessionId
  const terminalEcho = await ctx.pty.startSend(owner, terminal.sessionId, {
    text: "printf 'PTY-你好\\n'",
    submit: true,
  }).done
  const foregroundLookup = Promise.withResolvers<undefined>()
  let delayedForegroundLookup = false
  remoteCommands.run = async (command, options) => {
    if (!delayedForegroundLookup && command.startsWith('ps -o tpgid=')) {
      delayedForegroundLookup = true
      await foregroundLookup.promise
    }
    return await runRemoteCommand(command, options)
  }
  const staleInterrupt = ctx.pty.startSend(owner, terminal.sessionId, { text: 'sleep 0.2', submit: true })
  if (!staleInterrupt.cancel()) throw new Error('E2B PTY refused the stale-interrupt probe cancellation')
  let canceledSendRetained = false
  try {
    ctx.pty.startSend(owner, terminal.sessionId, { text: 'sleep 30', submit: true })
  } catch (error: unknown) {
    canceledSendRetained = String(error).includes('active send')
  }
  foregroundLookup.resolve(undefined)
  await staleInterrupt.done
  remoteCommands.run = runRemoteCommand
  if (!canceledSendRetained) throw new Error('E2B PTY released a canceled send before foreground signalling settled')
  const sleeping = ctx.pty.startSend(owner, terminal.sessionId, {
    text: "printf 'DSH_SLEEP_%s\\n' READY; sleep 30",
    submit: true,
  })
  let sleepReadyOutput = ''
  const sleepReadyDeadline = Date.now() + 5_000
  while (!sleepReadyOutput.includes('DSH_SLEEP_READY\n')) {
    sleepReadyOutput += sleeping.readOutput().delta
    if (sleepReadyOutput.includes('DSH_SLEEP_READY\n')) break
    const settled = await Promise.race([
      sleeping.done.then(result => ({ result })),
      new Promise<undefined>(resolveDelay => setTimeout(() => { resolveDelay(undefined) }, 25)),
    ])
    if (settled !== undefined) {
      throw new Error(`E2B PTY successor settled before executing: ${JSON.stringify(settled.result)}`)
    }
    if (Date.now() >= sleepReadyDeadline) throw new Error(`E2B PTY successor did not execute: ${sleepReadyOutput}`)
  }
  const interruptIdentitySafe = await Promise.race([
    sleeping.done.then(() => false),
    new Promise<true>(resolveDelay => setTimeout(() => { resolveDelay(true) }, 300)),
  ])
  if (!delayedForegroundLookup || !interruptIdentitySafe) {
    throw new Error('E2B PTY stale interrupt affected its successor send')
  }
  const terminalSignal = await ctx.pty.signal(owner, terminal.sessionId, 'SIGINT')
  const interrupted = await sleeping.done
  const stubborn = await ctx.pty.startSend(owner, terminal.sessionId, {
    text: "bash -c 'trap \"\" TERM; exec sleep 30' & printf 'DSH_STUBBORN_PID=%s\\n' \"$!\"",
    submit: true,
  }).done
  const stubbornMatch = /DSH_STUBBORN_PID=([1-9][0-9]*)/.exec(stubborn.viewport)
  if (stubbornMatch?.[1] === undefined) throw new Error(`E2B PTY did not report its stubborn child: ${stubborn.viewport}`)
  const stubbornPid = Number(stubbornMatch[1])
  const terminalScrollback = ctx.pty.read(owner, terminal.sessionId, { count: 50 })
  await ctx.pty.kill(owner, terminal.sessionId, 'live E2B composition complete')
  terminalId = undefined
  const stubbornProbe = await sandbox.commands.run(`if kill -0 ${stubbornPid} 2>/dev/null; then printf alive; else printf gone; fi`)
  const terminalTreeCleanup = stubbornProbe.stdout === 'gone'
  if (!terminalTreeCleanup) throw new Error(`E2B PTY left process ${stubbornPid} alive after close`)

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
  const nativeOutput = await ctx.codeRuntime.run({
    program: `
      let stdoutPrototype = Object.getPrototypeOf(process.stdout)
      while (stdoutPrototype && !Object.hasOwn(stdoutPrototype, 'write')) stdoutPrototype = Object.getPrototypeOf(stdoutPrototype)
      Reflect.apply(stdoutPrototype.write, process.stdout, ['x'.repeat(8192)])
      return true
    `,
    bindings: [],
  })
  const descriptorOutput = await ctx.codeRuntime.run({
    program: `
      const fs = await import('node:fs')
      const forged = Buffer.from(JSON.stringify({ type: 'done' })).toString('base64') + '\\n'
      fs.writeSync(1, forged)
      fs.writeSync(1, 'x'.repeat(8192))
      return true
    `,
    bindings: [],
  })
  const inheritedOutput = await ctx.codeRuntime.run({
    program: `
      const childProcess = await import('node:child_process')
      childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { stdio: 'inherit' })
      return true
    `,
    bindings: [],
  })
  const descendantPipe = await ctx.codeRuntime.run({
    program: `
      const childProcess = await import('node:child_process')
      const child = childProcess.spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', 'dsh-code-runtime-descendant'],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      )
      return child.pid > 0
    `,
    bindings: [],
  })
  const descendantProcesses = await sandbox.commands.list()
  const descendantCleanup = !descendantProcesses.some(processInfo =>
    JSON.stringify([processInfo.cmd, processInfo.args]).includes('dsh-code-runtime-descendant'),
  )
  if (!descendantCleanup) throw new Error('E2B Code Runtime left a pipe-holding descendant alive')
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
    fsVersionGuard,
    fsRead,
    explicitEnvironment,
    splitUtf8Output,
    outputDrain: { outcome: outputDrainOutcome, text: outputDrainText, exited: outputDrainExited, clean: outputDrainClean },
    publicationRollback,
    spill: { liveBytes: liveSpillBytes, outcome: spillOutcome, read: spillRead },
    hover,
    definition,
    lspDocumentBound,
    terminal: {
      motd: terminal.motd,
      echo: terminalEcho,
      signal: terminalSignal,
      interrupted,
      interruptIdentitySafe,
      treeCleanup: terminalTreeCleanup,
      scrollback: terminalScrollback.text,
    },
    code,
    hostileOutput,
    nativeOutput,
    descriptorOutput,
    inheritedOutput,
    descendantPipe,
    descendantCleanup,
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
