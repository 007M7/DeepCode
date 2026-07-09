import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { WorkerCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker'
import type { Config } from '@deepseek-ai/dsh-code-runtime-worker'
import type { CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/**
 * Integration suite over REAL worker threads (no mocks — workers are cheap
 * and local, per docs/testing.md's real-over-mock policy). Each test builds
 * a fresh context so budgets can be tuned per case.
 */
async function setup(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(WorkerCodeRuntime, config)
  const runtime = ctx.codeRuntime as WorkerCodeRuntime
  return { ctx, runtime }
}

/** Convenience: one namespace `tools` with the given functions. */
function tools(functions: Record<string, (args: unknown) => Promise<unknown>>) {
  return [{ global: 'tools', functions }]
}

describe('WorkerCodeRuntime — programs and bindings (real workers)', () => {
  it('registers with the seam descriptors', async () => {
    const { runtime } = await setup()
    expect(runtime.language).toBe('typescript')
    expect(runtime.isolation).toBe('worker-thread')
  })

  it('runs TypeScript (erasable syntax), captures console/stdout in order, returns the value', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `
        interface Point { x: number; y: number }
        const p: Point = { x: 1, y: 2 } as Point;
        console.log('point', p);
        process.stdout.write('raw-out\\n');
        console.warn('careful');
        return p.x + p.y;
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(3)
    expect(result.logs.map(entry => [entry.source, entry.level ?? null])).toEqual([
      ['console', 'log'],
      ['stdout', null],
      ['console', 'warn'],
    ])
    expect(result.logs[0]?.text).toBe('point { x: 1, y: 2 }')
  })

  it('bridges binding calls both ways and rejects the program-side call on a host rejection', async () => {
    const { runtime } = await setup()
    const calls: unknown[] = []
    const result = await runtime.run({
      program: `
        const first = await tools.echo({ n: 1 });
        let caught = '';
        try { await tools.fail({}) } catch (error) { caught = error.message }
        let caughtRaw = '';
        try { await tools.failRaw({}) } catch (error) { caughtRaw = error.message }
        return { first, caught, caughtRaw };
      `,
      bindings: tools({
        echo: async (args) => { calls.push(args); return { echoed: args } },
        fail: async () => { throw new Error('nope') },
        // A non-Error throw: the host renders it, the program still catches.
        failRaw: async () => { throw 'raw-nope' },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ first: { echoed: { n: 1 } }, caught: 'nope', caughtRaw: 'raw-nope' })
    expect(calls).toEqual([{ n: 1 }])
  })

  it('reports non-erasable syntax as an exception without spawning a worker', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'enum E { A }\nreturn 1', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toMatch(/enum|strip/i)
  })

  it('reports a runtime throw as an exception with the message', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'throw new Error("kaboom")', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('kaboom')
  })

  it('gives the program an EMPTY environment', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'return JSON.stringify(process.env)', bindings: [] })
    expect(result.value).toBe('{}')
  })

  it('replaces a non-cloneable return value with a string rendering', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'return { f: () => 1 }', bindings: [] })
    expect(typeof result.value).toBe('string')
  })

  it('completes a program that returns nothing with no value at all', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'const x = 1', bindings: [] })
    expect(result.error).toBeUndefined()
    expect('value' in result).toBe(false)
  })

  it('keeps logs streamed before a failure', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'console.log("before"); throw new Error("after-log")',
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.logs.map(entry => entry.text)).toContain('before')
  })
})

describe('WorkerCodeRuntime — budgets and containment (real workers)', () => {
  it('ends a hot loop at the compute budget — including behind a pending decoy dispatch', async () => {
    const { runtime } = await setup({ computeMs: 300, maxWallMs: 30_000 })
    const result = await runtime.run({
      // The decoy: fire a call at a never-resolving binding WITHOUT awaiting,
      // then spin. Host-side pending-call bookkeeping would pause a naive
      // budget here; measured busy time cannot be fooled.
      program: 'void tools.slow({}); for (;;) {}',
      bindings: tools({ slow: () => new Promise(() => {}) }),
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('compute budget')
  }, 15_000)

  it('does not charge time spent awaiting a slow binding against the compute budget', async () => {
    const { runtime } = await setup({ computeMs: 250, maxWallMs: 30_000 })
    const result = await runtime.run({
      program: 'return await tools.slow({})',
      bindings: tools({ slow: () => new Promise(resolve => setTimeout(() => { resolve('slow-done') }, 700)) }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('slow-done')
  }, 15_000)

  it('ends an idle-forever run at the wall-clock ceiling', async () => {
    const { runtime } = await setup({ computeMs: 30_000, maxWallMs: 400 })
    const result = await runtime.run({
      program: 'await tools.never({}); return 1',
      bindings: tools({ never: () => new Promise(() => {}) }),
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('wall-clock ceiling')
  }, 15_000)

  it('reports an abort mid-run and stops the worker', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    setTimeout(() => { controller.abort('user-cancel') }, 150)
    const result = await runtime.run({ program: 'for (;;) {}', bindings: [], signal: controller.signal })
    expect(result.error).toEqual({ kind: 'abort', message: 'user-cancel' })
  }, 15_000)

  it('reports a pre-aborted signal without spawning', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    controller.abort('too-late')
    const result = await runtime.run({ program: 'return 1', bindings: [], signal: controller.signal })
    expect(result.error).toEqual({ kind: 'abort', message: 'too-late' })
  })

  it('drops a binding resolution that lands after the run settled', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    let replyDelivered!: Promise<void>
    const result = await runtime.run({
      program: 'void tools.late({}); for (;;) {}',
      bindings: tools({
        // Anchored on invocation: abort 100ms after the call reaches the
        // host, resolve 400ms after — by then the run has settled, so the
        // resolution's reply hits the post-settlement drop.
        late: () => new Promise((resolve) => {
          setTimeout(() => { controller.abort('cancel-now') }, 100)
          replyDelivered = new Promise(done => setTimeout(() => { resolve('too-late'); done() }, 400))
        }),
      }),
      signal: controller.signal,
    })
    expect(result.error).toEqual({ kind: 'abort', message: 'cancel-now' })
    // Let the late resolution actually fire so its reply executes instead of
    // being cancelled with the test.
    await replyDelivered
  }, 15_000)

  it('contains an OOM under resourceLimits as worker-exit, host process healthy', async () => {
    const { runtime } = await setup({ maxOldGenerationSizeMb: 32 })
    const result = await runtime.run({
      program: 'const hog = []; for (;;) hog.push(new Array(1e6).fill(1));',
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    // And the host is fine: run something else.
    const after = await runtime.run({ program: 'return "alive"', bindings: [] })
    expect(after.value).toBe('alive')
  }, 30_000)

  it('truncates runaway log output at the byte budget with an in-band marker', async () => {
    const { runtime } = await setup({ maxLogBytes: 300 })
    const result = await runtime.run({
      program: 'for (let i = 0; i < 1000; i++) console.log("spam line", i); return 1',
      bindings: [],
    })
    expect(result.logs.at(-1)?.text).toContain('truncated at 300 bytes')
    const total = result.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0)
    expect(total).toBeLessThan(1_000)
  })

  it('caps an oversized return value with a truncation marker', async () => {
    const { runtime } = await setup({ maxValueBytes: 64 })
    const result = await runtime.run({ program: 'return "y".repeat(10_000)', bindings: [] })
    expect(result.value).toBe(`${'y'.repeat(64)}… [truncated]`)
  })

  it('caps a multibyte return value by UTF-8 bytes, not string length', async () => {
    // 4 code units, 12 UTF-8 bytes: a length-counting cap would let the full
    // string cross. The worker's byte-exact capped rendering then passes the
    // host re-cap unchanged (cap + marker is exactly the granted slack).
    const { runtime } = await setup({ maxValueBytes: 4 })
    const result = await runtime.run({ program: 'return "€€€€"', bindings: [] })
    expect(result.value).toBe('€… [truncated]')
  })

  it('completes a program that awaits its write callback, capturing the chunk', async () => {
    // Node's write(chunk[, encoding][, callback]) contract: dropping the
    // callback would leave this promise pending until the wall ceiling and
    // misreport a completed program as a timeout.
    const { runtime } = await setup({ maxWallMs: 2_000 })
    const result = await runtime.run({
      program: 'await new Promise(resolve => process.stdout.write("flushed", resolve)); return "done"',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toContainEqual({ source: 'stdout', text: 'flushed' })
  })

  it('caps a huge container whose bounded rendering is small (wire size, not rendering, is what counts)', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'return new Array(50_000).fill(7)', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(typeof result.value).toBe('string')
    expect(result.value).toContain('more items')
  })

  it('captures pipe writes that bypass the patched write slot as stray logs, capped by the same budget', async () => {
    const { runtime } = await setup({ maxLogBytes: 4 })
    const result = await runtime.run({
      // The bootstrap patches the stream instance's own `write`; going
      // through the prototype's slot reaches the real pipe underneath, so
      // the bytes arrive host-side as stray data. The pauses keep the two
      // writes in separate pipe chunks and let them land before settlement.
      program: `
        const write = (text) => Object.getPrototypeOf(process.stdout).write.call(process.stdout, text);
        write('abcd');
        await new Promise(resolve => setTimeout(resolve, 150));
        write('ef');
        await new Promise(resolve => setTimeout(resolve, 100));
        return 1;
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContainEqual({ source: 'stdout', text: 'abcd' })
    expect(result.logs.map(entry => entry.text)).not.toContain('ef')
  }, 15_000)
})

describe('WorkerCodeRuntime — hostile programs (real workers)', () => {
  it('survives forged port traffic: unknown binding names, duplicate ids, junk shapes', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `
        const { parentPort } = await import('node:worker_threads');
        parentPort.postMessage({ type: 'call', id: 7777, global: 'tools', name: 'missing', args: {} });
        parentPort.postMessage({ type: 'call', id: 7777, global: 'tools', name: 'missing', args: {} });
        parentPort.postMessage({ type: 'call', id: 7778, global: 'tools', name: 'constructor', args: {} });
        parentPort.postMessage({ type: 'junk' });
        return await tools.real({});
      `,
      bindings: tools({ real: async () => 'still-works' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('still-works')
  })

  it('survives arbitrary junk on the port: non-objects, junk types, malformed calls, logs, and dones', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `
        const { parentPort } = await import('node:worker_threads');
        for (const junk of [
          null, 42, 'junk', [],
          { type: 'nope' },
          { type: 'call' },
          { type: 'call', id: 'x', global: 'tools', name: 'real', args: {} },
          { type: 'call', id: 1e9, global: 7, name: 'real', args: {} },
          { type: 'call', id: 1e9, global: 'tools', name: 7, args: {} },
          { type: 'log' },
          { type: 'log', entry: null },
          { type: 'log', entry: { source: 'stdout', text: 7 } },
          { type: 'log', entry: { source: 'nope', text: 'x' } },
          { type: 'log', entry: { source: 'console', level: 'nope', text: 'x' } },
          { type: 'log', entry: { source: 'console', level: 7, text: 'x' } },
          { type: 'done', error: 5 },
          { type: 'done', error: { message: 5 } },
        ]) parentPort.postMessage(junk);
        return await tools.real({});
      `,
      bindings: tools({ real: async () => 'still-works' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('still-works')
    expect(result.logs).toEqual([])
  })

  it('caps forged log floods and forged done values at the configured budgets, dropping forged extra fields', async () => {
    const { runtime } = await setup({ maxLogBytes: 200, maxValueBytes: 64 })
    const result = await runtime.run({
      // Forged messages bypass the worker-side LogBuffer and prepareValue
      // entirely — only the host-side ledger and re-cap stand between model
      // code and an unbounded result.
      program: `
        const { parentPort } = await import('node:worker_threads');
        for (let i = 0; i < 50; i++) parentPort.postMessage({ type: 'log', entry: { source: 'stdout', text: 'F'.repeat(100), forged: true } });
        parentPort.postMessage({ type: 'done', value: 'V'.repeat(100000) });
        for (;;) {}
      `,
      bindings: [],
    })
    expect(typeof result.value).toBe('string')
    const value = result.value as string
    expect(value.startsWith('V'.repeat(64))).toBe(true)
    expect(value.endsWith('… [truncated]')).toBe(true)
    expect(value.length).toBeLessThan(120)
    const marker = '[dsh-code-runtime-worker] log capture truncated at 200 bytes'
    const total = result.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0)
    expect(total).toBeLessThanOrEqual(200 + Buffer.byteLength(marker, 'utf8'))
    expect(result.logs.at(-1)?.text).toBe(marker)
    expect(result.logs.every(entry => !('forged' in entry))).toBe(true)
  })

  it('accepts a forged done carrying both value and error (self-sabotage, contained)', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: `
        const { parentPort } = await import('node:worker_threads');
        parentPort.postMessage({ type: 'done', value: 'lied', error: { message: 'fake failure' } });
        for (;;) {}
      `,
      bindings: [],
    })
    expect(result.value).toBe('lied')
    expect(result.error).toEqual({ kind: 'exception', message: 'fake failure' })
  })

  it('byte-bounds forged multibyte error text at the host', async () => {
    // Forged error text bypasses the worker entirely; the host bound is a
    // BYTE bound (two € = 6 bytes fit an 8-byte cap, a third would not).
    const { runtime } = await setup({ maxValueBytes: 8 })
    const result = await runtime.run({
      program: `
        const { parentPort } = await import('node:worker_threads');
        parentPort.postMessage({ type: 'done', error: { message: '€'.repeat(1000) } });
        for (;;) {}
      `,
      bindings: [],
    })
    expect(result.error).toEqual({ kind: 'exception', message: '€€' })
  })

  it('answers a binding whose resolution cannot be cloned with a failure reply', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'try { await tools.bad({}) } catch (error) { return error.message }',
      bindings: tools({ bad: async () => (() => 1) }),
    })
    expect(result.value).toContain('not structured-cloneable')
  })

  it('exposes binding names that collide with Object.prototype as ordinary functions', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'return [await tools["__proto__"]({}), await tools["constructor"]({}), typeof tools["hasOwnProperty"]]',
      // Computed keys: a literal `'__proto__': …` entry would SET the record's
      // prototype instead of declaring a binding of that name.
      bindings: tools({ ['__proto__']: async () => 'proto-ok', ['constructor']: async () => 'ctor-ok' }),
    })
    expect(result.value).toEqual(['proto-ok', 'ctor-ok', 'undefined'])
  })
})

describe('WorkerCodeRuntime — seam misuse and lifecycle', () => {
  it('rejects invalid binding globals loudly (identifier, reserved word, duplicate, console)', async () => {
    const { runtime } = await setup()
    const cases: [string, RegExp][] = [
      ['not valid!', /not a usable identifier/],
      ['await', /not a usable identifier/],
      ['console', /duplicate binding global/],
    ]
    for (const [global, message] of cases) {
      await expect(runtime.run({ program: 'return 1', bindings: [{ global, functions: {} }] })).rejects.toThrow(message)
    }
    await expect(runtime.run({
      program: 'return 1',
      bindings: [{ global: 'tools', functions: {} }, { global: 'tools', functions: {} }],
    })).rejects.toThrow(/duplicate binding global/)
  })

  it('rejects config values that are not positive numbers', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(WorkerCodeRuntime, { computeMs: -1 })).rejects.toThrow(/positive number/)
  })

  it('keeps runs isolated: no state survives from one run to the next', async () => {
    const { runtime } = await setup()
    await runtime.run({ program: 'globalThis.leak = "value"; return 1', bindings: [] })
    const second = await runtime.run({ program: 'return typeof globalThis.leak', bindings: [] })
    expect(second.value).toBe('undefined')
  })

  it('disposal aborts in-flight runs, awaits worker exit, and rejects later runs', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(WorkerCodeRuntime)
    const runtime = ctx.codeRuntime as WorkerCodeRuntime
    const inflight: Promise<CodeRunResult> = runtime.run({ program: 'for (;;) {}', bindings: [] })
    // Give the worker a moment to actually start spinning.
    await new Promise(resolve => setTimeout(resolve, 200))
    await fiber.dispose()
    const result = await inflight
    expect(result.error).toEqual({ kind: 'abort', message: 'runtime disposed' })
    await expect(runtime.run({ program: 'return 1', bindings: [] })).rejects.toThrow(/after disposal/)
  }, 15_000)

  it('removes ctx.codeRuntime when the providing fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(WorkerCodeRuntime)
    expect(ctx.get('codeRuntime')).toBeInstanceOf(WorkerCodeRuntime)
    await fiber.dispose()
    expect(ctx.get('codeRuntime')).toBeUndefined()
  })
})
