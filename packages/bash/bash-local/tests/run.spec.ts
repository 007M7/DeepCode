import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { killGroup, OutputCollector, runBash } from '@deepseek-ai/dsh-bash-local'
import type { RunningBash } from '@deepseek-ai/dsh-bash-local'

const { failNextClose } = vi.hoisted(() => ({ failNextClose: { value: false } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync(fd: number): void {
      if (failNextClose.value) {
        failNextClose.value = false
        throw Object.assign(new Error('simulated EIO on close'), { code: 'EIO' })
      }
      actual.closeSync(fd)
    },
  }
})

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-spec-'))

function spec(command: string, overrides: Partial<Parameters<typeof runBash>[0]> = {}) {
  return {
    command,
    cwd: process.cwd(),
    maxOutputBytes: 64_000,
    graceMs: 3_000,
    ...overrides,
  }
}

/** Poll until a pid no longer exists (kill(pid, 0) throws ESRCH). */
async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

async function waitForStdout(running: RunningBash, expected: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (running.stdout.snapshot().text.includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`stdout did not include ${JSON.stringify(expected)} after ${timeoutMs}ms`)
}

async function waitForPidFile(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // The child shell has not written the pid file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written after ${timeoutMs}ms`)
}

describe('runBash', () => {
  it('captures stdout on success', async () => {
    const result = await runBash(spec('echo hello')).done
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout.text).toBe('hello\n')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.text).toBe('')
  })

  it('captures stderr separately', async () => {
    const result = await runBash(spec('echo oops >&2')).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
    expect(result.stderr.text).toBe('oops\n')
  })

  it('captures both streams', async () => {
    const result = await runBash(spec('echo out; echo err >&2')).done
    expect(result.stdout.text).toBe('out\n')
    expect(result.stderr.text).toBe('err\n')
  })

  it('reports non-zero exit codes', async () => {
    const result = await runBash(spec('exit 42')).done
    expect(result.exitCode).toBe(42)
    expect(result.signal).toBeNull()
  })

  it('applies model-friendly env overrides', async () => {
    const result = await runBash(spec('echo "$NO_COLOR/$TERM/$PAGER"')).done
    expect(result.stdout.text).toBe('1/dumb/cat\n')
  })

  it('runs in the requested cwd', async () => {
    const result = await runBash(spec('pwd', { cwd: '/tmp' })).done
    expect(result.stdout.text.trim()).toMatch(/\/tmp$/)
  })

  it('kills the process group with SIGTERM when the signal fires', async () => {
    // runBash owns no timer: it kills on abort. The executor drives the timeout
    // by firing this signal via a deadline (see executor.spec.ts); here we
    // assert the kill itself lands as SIGTERM.
    const controller = new AbortController()
    const start = Date.now()
    const running = runBash(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('deadline') }, 100)
    const result = await running.done
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
  })

  it('escalates to SIGKILL when SIGTERM is trapped', async () => {
    const running = runBash(spec('trap \'\' TERM; echo ready; while :; do sleep 60 & wait $!; done', { graceMs: 200 }))
    await waitForStdout(running, 'ready\n')
    running.kill()
    const result = await running.done
    expect(result.signal).toBe('SIGKILL')
  })

  it('kills the whole process group (grandchildren die too)', async () => {
    // The subshell writes the sleep's pid then waits on it; killing the
    // group must take the sleep down with bash.
    const pidFile = join(spillDir, `grandchild-${Date.now()}.pid`)
    const running = runBash(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    const grandchild = await waitForPidFile(pidFile)
    expect(grandchild).toBeGreaterThan(0)

    running.kill()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
    await waitGone(grandchild)
  })

  it('aborts via AbortSignal mid-run', async () => {
    const controller = new AbortController()
    const running = runBash(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('user cancelled') }, 50)
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
  })

  it('throws when the signal is already aborted before spawn', () => {
    const controller = new AbortController()
    controller.abort('too late')
    expect(() => runBash(spec('echo hi', { signal: controller.signal })))
      .toThrow(/aborted before spawn: too late/)
  })

  it('rejects with a spawn error for a nonexistent cwd', async () => {
    await expect(runBash(spec('echo hi', { cwd: '/nonexistent-dir-dsh-test' })).done)
      .rejects.toThrow(/ENOENT/)
  })

  it('kill() is idempotent (second call does not restart escalation)', async () => {
    const running = runBash(spec('sleep 60'))
    running.kill()
    running.kill()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
  })
})

describe('stdin and extra env (set by in-process plugins)', () => {
  it('writes stdin to the command and closes it', async () => {
    const result = await runBash(spec('cat', { stdin: 'hello from stdin\n' })).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hello from stdin\n')
  })

  it('a command that reads stdin sees EOF when none is supplied', async () => {
    // No stdin → fd 0 is /dev/null, so `cat` reads EOF and exits 0 with no
    // output (it does NOT block).
    const result = await runBash(spec('cat')).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
  })

  it('gives fd 0 the exact pre-seam type: /dev/null when no stdin, a pipe when supplied', async () => {
    // The no-stdin path must stay observationally identical to the pre-seam
    // `ignore` default: a command that probes stdin's file type sees a char
    // device (/dev/null). Regressing to an always-open pipe would make fd 0 a
    // socket (node's spawn pipe is an AF_UNIX socket, not a FIFO), flipping
    // `test -c /dev/stdin` for every model-driven call. When bytes ARE supplied,
    // fd 0 is that pipe (a socket), as it must be to carry them.
    const none = await runBash(spec('test -c /dev/stdin && echo char || echo other')).done
    expect(none.stdout.text).toBe('char\n')
    const piped = await runBash(spec('test -S /dev/stdin && echo socket || echo other', { stdin: 'x' })).done
    expect(piped.stdout.text).toBe('socket\n')
  })

  it('merges extra env entries onto the scrubbed environment', async () => {
    const result = await runBash(spec('echo "$DSH_EXTRA_ONE/$DSH_EXTRA_TWO"', {
      env: { DSH_EXTRA_ONE: 'alpha', DSH_EXTRA_TWO: 'beta' },
    })).done
    expect(result.stdout.text).toBe('alpha/beta\n')
  })

  it('an explicit extra env entry overrides the model-friendly override and the scrub', async () => {
    // TERM is a model-friendly OVERRIDE (dumb); an explicit extra entry wins.
    // DSH_OVERRIDE_KEY matches the credential scrub pattern, yet an explicit
    // entry is still honored — the scrub only drops AMBIENT process.env creds.
    const result = await runBash(spec('echo "$TERM/$DSH_OVERRIDE_KEY"', {
      env: { TERM: 'xterm-256color', DSH_OVERRIDE_KEY: 'explicit-wins' },
    })).done
    expect(result.stdout.text).toBe('xterm-256color/explicit-wins\n')
  })

  it('does not crash or reject when the child ignores a large stdin (EPIPE)', async () => {
    // The child exits immediately without reading; closing our end of a stdin
    // pipe still holding ~1MiB triggers EPIPE on the write. The handler must
    // swallow it: `done` resolves normally with the child's real exit.
    const big = 'x'.repeat(1024 * 1024)
    const result = await runBash(spec('exit 7', { stdin: big })).done
    expect(result.exitCode).toBe(7)
  })
})

describe('output truncation and spill', () => {
  it('keeps the tail and spills the full stream to disk', async () => {
    // 200 numbered lines of ~10 bytes; cap at 500 bytes keeps a late tail.
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text.length).toBeLessThanOrEqual(500)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.text).not.toContain('line-0001')
    expect(result.stdout.spillPath).toBeDefined()
    const full = readFileSync(result.stdout.spillPath!, 'utf8')
    expect(full).toContain('line-0001')
    expect(full).toContain('line-0200')
  })

  it('does not truncate output exactly at the cap', async () => {
    const result = await runBash(
      spec('printf "%.0sx" $(seq 1 500)', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text.length).toBe(500)
    expect(result.stdout.spillPath).toBeUndefined()
  })

  it('settles with the tail and no spill path when final spill close fails', async () => {
    failNextClose.value = true
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    expect(failNextClose.value).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.spillPath).toBeUndefined()
  })
})

describe('OutputCollector', () => {
  it('keeps the tail of a single oversized chunk', () => {
    const collector = new OutputCollector(10, 'test', spillDir)
    collector.push(Buffer.from('0123456789abcdef'))
    const out = collector.finalize()
    expect(out.text).toBe('6789abcdef')
    expect(out.truncated).toBe(true)
    expect(readFileSync(out.spillPath!, 'utf8')).toBe('0123456789abcdef')
  })

  it('readFrom returns increments and flags lossy reads', () => {
    const collector = new OutputCollector(10, 'test', spillDir)
    collector.push(Buffer.from('aaaaa'))
    const first = collector.readFrom(0)
    expect(first.text).toBe('aaaaa')
    expect(first.lossy).toBe(false)
    expect(first.nextOffset).toBe(5)

    collector.push(Buffer.from('bbbbb'))
    const second = collector.readFrom(first.nextOffset)
    expect(second.text).toBe('bbbbb')
    expect(second.lossy).toBe(false)

    // Push enough to slide the window past the last offset.
    collector.push(Buffer.from('c'.repeat(20)))
    const third = collector.readFrom(second.nextOffset)
    expect(third.lossy).toBe(true)
    expect(third.text).toBe('c'.repeat(10))
    expect(third.spillPath).toBeDefined()
  })

  it('tracks totalBytes across drops', () => {
    const collector = new OutputCollector(4, 'test', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    expect(collector.totalBytes).toBe(8)
    expect(collector.finalize().text).toBe('bbbb')
  })

  it('contains close failures and drops the spill path', () => {
    const collector = new OutputCollector(4, 'closefail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    expect(collector.snapshot().spillPath).toBeDefined()

    failNextClose.value = true
    let out: ReturnType<typeof collector.finalize>
    expect(() => { out = collector.finalize() }).not.toThrow()

    expect(failNextClose.value).toBe(false)
    expect(out!.text).toBe('bbbb')
    expect(out!.truncated).toBe(true)
    expect(out!.spillPath).toBeUndefined()
  })
})

describe('killGroup', () => {
  it('ignores non-positive pids', () => {
    expect(() => { killGroup(-1, 'SIGTERM') }).not.toThrow()
    expect(() => { killGroup(0, 'SIGTERM') }).not.toThrow()
  })

  it('swallows ESRCH for vanished groups', async () => {
    const running = runBash(spec('true'))
    await running.done
    expect(() => { killGroup(running.pid, 'SIGTERM') }).not.toThrow()
  })
})

describe('abort edge cases', () => {
  it('reports a fallback reason for reason-less pre-aborted signals', () => {
    // Real AbortControllers always set a DOMException reason; signal-like
    // objects from other libraries may not — the fallback covers them.
    const bare = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    expect(() => runBash(spec('echo hi', { signal: bare })))
      .toThrow(/aborted before spawn: aborted/)
  })

  it('reports the terminating signal of an externally self-killed command', async () => {
    // runBash reports the raw signal; whether it counts as timeout/cancel is the
    // executor's classification (a self-kill is neither) — see executor.spec.ts.
    const result = await runBash(spec('kill -TERM $$')).done
    expect(result.signal).toBe('SIGTERM')
  })
})

describe('review fixes: env scrubbing and spill hardening', () => {
  it('scrubs credential-shaped env vars from child processes', async () => {
    process.env.DSH_TEST_API_KEY = 'super-secret'
    process.env.DSH_TEST_TOKEN = 'also-secret'
    process.env.DSH_TEST_PLAIN = 'visible'
    try {
      const result = await runBash(spec('echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${DSH_TEST_PLAIN:-absent}]"')).done
      expect(result.stdout.text.trim()).toBe('[absent|absent|visible]')
    } finally {
      delete process.env.DSH_TEST_API_KEY
      delete process.env.DSH_TEST_TOKEN
      delete process.env.DSH_TEST_PLAIN
    }
  })

  it('creates spill files with owner-only permissions and random names', async () => {
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
      { spillDir },
    ).done
    const path = result.stdout.spillPath!
    expect(path).toMatch(/dsh-bash-\d+-\d+-[0-9a-f]{12}-stdout\.log$/)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('defaults spills into a private per-process directory', async () => {
    const result = await runBash(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { maxOutputBytes: 500 }),
    ).done
    const dir = dirname(result.stdout.spillPath!)
    expect(dir).toMatch(/dsh-bash-/)
    const mode = statSync(dir).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('killGroup never throws, even for EPERM-style failures', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    try {
      expect(() => { killGroup(12345, 'SIGTERM') }).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it('honors AbortSignal on background-style runs (no timeout)', async () => {
    const controller = new AbortController()
    const running = runBash(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
  })
})
