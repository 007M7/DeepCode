import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  buildChildEnv,
  createIsolatedConfigDir,
  disposeChildProcess,
  spawnFailure,
} from '../src/index.ts'

// `rm` is real-passthrough except for one deterministic failure. Permission-based recursive-rm
// failures are not portable and disappear under root, so this is the sanctioned filesystem seam.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

/**
 * Unit tests for the shared out-of-process machinery. The env scrub and the
 * isolated-config-dir helpers run against the REAL process env and REAL
 * filesystem (one exception: the rm-failure path injects its rejection at the
 * mocked fs boundary, see above); the exit waits and the dispose ladder run
 * against a scriptable fake child so each escalation tier's timing is driven
 * deterministically (the ACP backend's suite exercises the same ladder
 * against real subprocesses end to end).
 */

/** What fells a scripted {@link FakeChild}. */
type LethalTrigger = 'eof' | NodeJS.Signals

/** Per-scenario script for a {@link FakeChild}. */
interface FakeChildScript {
  /**
   * The one trigger that makes the child exit (SIGKILL always does,
   * uncatchable, like a real process). Omitted: only SIGKILL fells it.
   */
  diesOn?: LethalTrigger
  /** Delay (ms) between the lethal trigger and the exit event. */
  delayMs?: number
  /** Complete the scripted exit inside the triggering call. */
  synchronousExit?: boolean
  /** `false` models a child spawned without a stdin pipe. */
  stdin?: boolean
}

/**
 * A scriptable stand-in for a ChildProcess carrying exactly the surface the
 * helpers read: `exitCode`/`signalCode`, `stdin.end()`, `kill()`, and the
 * `exit` event.
 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: NodeJS.Signals[] = []
  stdinEnded = false
  readonly stdin: { end: () => void } | null

  constructor(private readonly script: FakeChildScript = {}) {
    super()
    this.stdin = script.stdin === false
      ? null
      : { end: () => { this.stdinEnded = true; this.maybeDie('eof') } }
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    this.maybeDie(signal)
    return true
  }

  private maybeDie(trigger: LethalTrigger): void {
    // SIGKILL is uncatchable — it always fells the child; any other trigger
    // only when the scenario scripts it as the lethal one.
    if (trigger !== 'SIGKILL' && this.script.diesOn !== trigger) return
    const exit = (): void => {
      if (trigger === 'eof') this.exitCode = 0
      else this.signalCode = trigger
      this.emit('exit', this.exitCode, this.signalCode)
    }
    if (this.script.synchronousExit === true) exit()
    else setTimeout(exit, this.script.delayMs ?? 0)
  }
}

/** The helpers take a real ChildProcess; the fake carries the read surface. */
function asChild(fake: FakeChild): ChildProcess {
  return fake as unknown as ChildProcess
}

describe('buildChildEnv', () => {
  it('drops credential-shaped ambient vars (KEY/SECRET/TOKEN, case-insensitive)', () => {
    process.env.DSH_PROC_TEST_API_KEY = 'leak'
    process.env.dsh_proc_test_secret = 'leak'
    process.env.DSH_PROC_TEST_TOKEN = 'leak'
    try {
      const env = buildChildEnv({})
      expect(env.DSH_PROC_TEST_API_KEY).toBeUndefined()
      expect(env.dsh_proc_test_secret).toBeUndefined()
      expect(env.DSH_PROC_TEST_TOKEN).toBeUndefined()
    } finally {
      delete process.env.DSH_PROC_TEST_API_KEY
      delete process.env.dsh_proc_test_secret
      delete process.env.DSH_PROC_TEST_TOKEN
    }
  })

  it('forwards normal ambient vars', () => {
    expect(buildChildEnv({}).PATH).toBe(process.env.PATH)
  })

  it('layers extras AFTER the scrub, so a deliberate credential-shaped name survives', () => {
    process.env.DSH_PROC_TEST_EXTRA_TOKEN = 'ambient-leak'
    try {
      const env = buildChildEnv({ DSH_PROC_TEST_EXTRA_TOKEN: 'explicit' })
      // The ambient value was scrubbed; ONLY the explicit opt-in reaches the child.
      expect(env.DSH_PROC_TEST_EXTRA_TOKEN).toBe('explicit')
    } finally {
      delete process.env.DSH_PROC_TEST_EXTRA_TOKEN
    }
  })

  it('an extra overrides the ambient value of a non-credential var', () => {
    process.env.DSH_PROC_TEST_PLAIN = 'ambient'
    try {
      expect(buildChildEnv({ DSH_PROC_TEST_PLAIN: 'override' }).DSH_PROC_TEST_PLAIN).toBe('override')
    } finally {
      delete process.env.DSH_PROC_TEST_PLAIN
    }
  })
})

describe('spawnFailure', () => {
  it('resolves (never rejects) with the first error event', async () => {
    const fake = new FakeChild()
    const failure = spawnFailure(asChild(fake))
    const err = new Error('spawn ENOENT')
    fake.emit('error', err)
    await expect(failure).resolves.toBe(err)
  })

  it('never settles for a child that spawns cleanly and exits', async () => {
    const fake = new FakeChild({ diesOn: 'SIGTERM' })
    const failure = spawnFailure(asChild(fake))
    fake.kill('SIGTERM')
    await new Promise<void>(resolve => fake.once('exit', () => { resolve() }))
    // A clean lifecycle emits `exit`, never `error` — the capture stays
    // pending forever, so a race against it is decided by the other arms.
    const settled = await Promise.race([
      failure.then(() => 'settled'),
      new Promise<string>(resolve => setTimeout(() => { resolve('pending') }, 30)),
    ])
    expect(settled).toBe('pending')
  })
})

describe('disposeChildProcess', () => {
  it('returns immediately for an already-exited child (no EOF, no signals)', async () => {
    const fake = new FakeChild()
    fake.exitCode = 0
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
    expect(fake.stdinEnded).toBe(false)
    expect(fake.kills).toEqual([])
  })

  it('returns immediately for a child already dead by signal', async () => {
    const fake = new FakeChild()
    fake.signalCode = 'SIGKILL'
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
    expect(fake.stdinEnded).toBe(false)
    expect(fake.kills).toEqual([])
  })

  it('tier 1: a cooperative child quiesces on stdin EOF — no signal is ever sent', async () => {
    const fake = new FakeChild({ diesOn: 'eof', delayMs: 5 })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
    expect(fake.stdinEnded).toBe(true)
    expect(fake.kills).toEqual([])
    expect(fake.exitCode).toBe(0)
  })

  it('recognizes a child that exits synchronously on stdin EOF', async () => {
    const fake = new FakeChild({ diesOn: 'eof', synchronousExit: true })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 1000, disposeGraceMs: 1000 })
    expect(fake.exitCode).toBe(0)
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('tier 2: a child that ignores EOF but honors SIGTERM dies on the middle rung', async () => {
    const fake = new FakeChild({ diesOn: 'SIGTERM', delayMs: 5 })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 1000 }, 'linux')
    expect(fake.stdinEnded).toBe(true)
    expect(fake.kills).toEqual(['SIGTERM'])
    expect(fake.signalCode).toBe('SIGTERM')
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('recognizes a child that exits synchronously on SIGTERM', async () => {
    const fake = new FakeChild({ diesOn: 'SIGTERM', synchronousExit: true })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 1000 }, 'linux')
    expect(fake.kills).toEqual(['SIGTERM'])
    expect(fake.signalCode).toBe('SIGTERM')
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('tier 3: a SIGTERM-trapping child is SIGKILLed, and dispose resolves only after the exit', async () => {
    const fake = new FakeChild({ delayMs: 5 }) // only SIGKILL fells it
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 20 }, 'linux')
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL'])
    // Quiescence, not a request: at resolution the child has ACTUALLY exited
    // (the exit event landed, despite the scripted post-SIGKILL delay).
    expect(fake.signalCode).toBe('SIGKILL')
  })

  it('recognizes a child already gone when the final exit wait begins', async () => {
    const fake = new FakeChild({ synchronousExit: true })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 20 }, 'linux')
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(fake.signalCode).toBe('SIGKILL')
  })

  it.each(['exitCode', 'signalCode'] as const)('accepts a late OS %s marker before the final forced wait', async (marker) => {
    const fake = new FakeChild()
    vi.spyOn(fake, 'kill').mockImplementation((signal) => {
      fake.kills.push(signal)
      queueMicrotask(() => {
        if (marker === 'exitCode') fake.exitCode = 0
        else fake.signalCode = 'SIGTERM'
      })
      return true
    })

    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 1, disposeGraceMs: 10 }, 'linux')
    expect(fake.kills).toEqual(['SIGTERM'])
  })

  it('walks the ladder for a child spawned without a stdin pipe', async () => {
    const fake = new FakeChild({ stdin: false, diesOn: 'SIGTERM', delayMs: 5 })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 1000 }, 'linux')
    expect(fake.kills).toEqual(['SIGTERM'])
  })

  it('skips the redundant SIGTERM tier on Windows and awaits forced exit', async () => {
    const fake = new FakeChild({ diesOn: 'SIGTERM', delayMs: 5 })
    await disposeChildProcess(asChild(fake), { disposeEofGraceMs: 20, disposeGraceMs: 1000 }, 'win32')
    expect(fake.kills).toEqual(['SIGKILL'])
    expect(fake.signalCode).toBe('SIGKILL')
  })

  it('propagates a forced-termination error without waiting for the grace', async () => {
    const fake = new FakeChild()
    const failure = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    vi.spyOn(fake, 'kill').mockImplementation((signal) => {
      fake.kills.push(signal)
      fake.emit('error', failure)
      return false
    })

    await expect(disposeChildProcess(
      asChild(fake),
      { disposeEofGraceMs: 1, disposeGraceMs: 1000 },
      'win32',
    )).rejects.toBe(failure)
    expect(fake.kills).toEqual(['SIGKILL'])
    expect(fake.listenerCount('error')).toBe(0)
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('wraps a synchronous forced-termination exception and removes its listeners', async () => {
    const fake = new FakeChild()
    const failure = new Error('invalid signal state')
    vi.spyOn(fake, 'kill').mockImplementation(() => { throw failure })

    await expect(disposeChildProcess(
      asChild(fake),
      { disposeEofGraceMs: 1, disposeGraceMs: 1000 },
      'win32',
    )).rejects.toMatchObject({ message: 'SIGKILL failed', cause: failure })
    expect(fake.listenerCount('error')).toBe(0)
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('bounds a refused forced termination that produces no error or exit', async () => {
    const fake = new FakeChild()
    vi.spyOn(fake, 'kill').mockImplementation((signal) => {
      fake.kills.push(signal)
      return false
    })

    await expect(disposeChildProcess(
      asChild(fake),
      { disposeEofGraceMs: 1, disposeGraceMs: 10 },
      'win32',
    )).rejects.toThrow('child process did not exit within 10ms after SIGKILL was refused')
    expect(fake.listenerCount('error')).toBe(0)
    expect(fake.listenerCount('exit')).toBe(0)
  })

  it('bounds an accepted forced termination that never reports exit', async () => {
    const fake = new FakeChild()
    vi.spyOn(fake, 'kill').mockImplementation((signal) => {
      fake.kills.push(signal)
      return true
    })

    await expect(disposeChildProcess(
      asChild(fake),
      { disposeEofGraceMs: 1, disposeGraceMs: 10 },
      'win32',
    )).rejects.toThrow('child process did not exit within 10ms after SIGKILL was accepted')
    expect(fake.listenerCount('error')).toBe(0)
    expect(fake.listenerCount('exit')).toBe(0)
  })
})

describe('createIsolatedConfigDir', () => {
  it('creates a fresh private mkdtemp dir under the OS temp root', async () => {
    const dir = await createIsolatedConfigDir('dsh-subagent-subprocess-test-')
    try {
      expect(dir.path.startsWith(join(tmpdir(), 'dsh-subagent-subprocess-test-'))).toBe(true)
      const st = await stat(dir.path)
      expect(st.isDirectory()).toBe(true)
      // Windows reports synthetic POSIX mode bits; privacy comes from the
      // inherited directory ACL rather than chmod-compatible mode bits.
      if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o700)
    } finally {
      await dir.remove()
    }
  })

  it('creates a distinct dir per call (per-run isolation)', async () => {
    const a = await createIsolatedConfigDir('dsh-subagent-subprocess-test-')
    const b = await createIsolatedConfigDir('dsh-subagent-subprocess-test-')
    try {
      expect(a.path).not.toBe(b.path)
    } finally {
      await a.remove()
      await b.remove()
    }
  })

  it('remove() deletes a fresh dir recursively and is idempotent', async () => {
    const dir = await createIsolatedConfigDir('dsh-subagent-subprocess-test-')
    await writeFile(join(dir.path, 'settings.json'), '{}')
    await dir.remove()
    expect(existsSync(dir.path)).toBe(false)
    // Second remove: nothing left to delete, still resolves.
    await expect(dir.remove()).resolves.toBeUndefined()
  })

  it('returns a pinned dir verbatim and NEVER removes it', async () => {
    const pinned = await mkdtemp(join(tmpdir(), 'dsh-subagent-subprocess-pinned-'))
    try {
      const dir = await createIsolatedConfigDir('ignored-prefix-', pinned)
      expect(dir.path).toBe(pinned)
      await dir.remove()
      // The deployment owns a pinned dir's lifecycle — remove() must not touch it.
      expect(existsSync(pinned)).toBe(true)
    } finally {
      await rm(pinned, { recursive: true, force: true })
    }
  })

  it('does not create a missing pinned path (the deployment owns its lifecycle)', async () => {
    const missing = join(tmpdir(), `dsh-subagent-subprocess-missing-${process.pid}`)
    const dir = await createIsolatedConfigDir('ignored-prefix-', missing)
    expect(dir.path).toBe(missing)
    expect(existsSync(missing)).toBe(false)
    await dir.remove()
    expect(existsSync(missing)).toBe(false)
  })

  it('remove() is best-effort: an rm rejection resolves instead of rejecting', async () => {
    const dir = await createIsolatedConfigDir('dsh-subagent-subprocess-locked-')
    try {
      // The swallow contract is error-kind agnostic; EACCES stands in for the
      // family (EBUSY, a vanished mount, …) that best-effort must absorb.
      vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      await expect(dir.remove()).resolves.toBeUndefined()
      // The injected rejection consumed the only rm call — nothing was deleted.
      expect(existsSync(dir.path)).toBe(true)
    } finally {
      await rm(dir.path, { recursive: true, force: true })
    }
  })
})
