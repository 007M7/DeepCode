import { describe, expect, it } from 'vitest'
import type {
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeRunResult,
  CodeRuntime,
} from '@deepseek-ai/dsh-code-runtime'

interface WorkerCodeRuntimeContractConfig {
  computeMs?: number
  maxWallMs?: number
  maxOutputBytes?: number
  maxOldGenerationSizeMb?: number
}

interface WorkerCodeRuntimeContractHarness {
  runtime: CodeRuntime
  dispose: () => Promise<void>
}

type WorkerCodeRuntimeContractSetup = (
  config?: WorkerCodeRuntimeContractConfig,
) => Promise<WorkerCodeRuntimeContractHarness>

/** Convenience: one namespace `tools` with the given functions. */
export function workerRuntimeTools(
  functions: Record<string, (args: unknown) => Promise<unknown>>,
): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions: functions as Record<string, CodeBindingFunction>,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  }]
}

/** Run behavior shared by the direct and subprocess-hosted worker runtimes. */
export function runWorkerCodeRuntimeContract(
  label: string,
  setup: WorkerCodeRuntimeContractSetup,
): void {
  describe(`${label} — programs and bindings (real workers)`, () => {
    it('registers with the seam descriptors', async () => {
      const { runtime } = await setup()
      expect(runtime.language).toBe('typescript')
      expect(runtime.isolation).toBe('worker-thread')
    })

    it('runs TypeScript (erasable syntax), captures output in order, returns the value', async () => {
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
      expect(result.logs).toEqual(['point { x: 1, y: 2 }', 'raw-out\n', 'careful'])
    })

    it('bridges binding calls both ways and rejects the program-side call on a host rejection', async () => {
      const { runtime } = await setup()
      const calls: unknown[] = []
      const result = await runtime.run({
        program: `
          const first = await tools.echo({ n: 1 });
          let caught = {};
          try { await tools.fail({}) } catch (error) { caught = { isTyped: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } }
          let caughtRaw = {};
          try { await tools.failRaw({}) } catch (error) { caughtRaw = { name: error.name, toolName: error.toolName, message: error.message } }
          return { first, caught, caughtRaw };
        `,
        bindings: workerRuntimeTools({
          echo: async (args) => { calls.push(args); return { echoed: args } },
          fail: async () => { throw new Error('nope') },
          // A non-Error throw: the host renders it, the program still catches.
          failRaw: async () => { throw 'raw-nope' },
        }),
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({
        first: { echoed: { n: 1 } },
        caught: { isTyped: true, name: 'ToolCallError', toolName: 'fail', message: 'nope' },
        caughtRaw: { name: 'ToolCallError', toolName: 'failRaw', message: 'raw-nope' },
      })
      expect(calls).toEqual([{ n: 1 }])
    })

    it('materializes a typed rejection from a generic namespace descriptor', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          try { await helpers.fail({}) } catch (error) {
            return {
              isTyped: error instanceof HelperCallError,
              name: error.name,
              helperName: error.helperName,
              message: error.message,
            };
          }
        `,
        bindings: [{
          global: 'helpers',
          functions: { fail: async () => { throw new Error('nope') } },
          errorClass: { name: 'HelperCallError', memberNameProperty: 'helperName' },
        }],
      })
      expect(result.value).toEqual({
        isTyped: true,
        name: 'HelperCallError',
        helperName: 'fail',
        message: 'nope',
      })
    })

    it('bridges a deeply nested lossless JSON argument, resolution, and completion', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          let value = 'leaf';
          for (let depth = 0; depth < 3_000; depth++) value = [value];
          return await tools.echo(value);
        `,
        bindings: workerRuntimeTools({ echo: async args => args }),
      })

      expect(result.error).toBeUndefined()
      let cursor = result.value
      for (let depth = 0; depth < 3_000; depth++) {
        expect(Array.isArray(cursor)).toBe(true)
        cursor = Array.isArray(cursor) ? cursor[0] : undefined
      }
      expect(cursor).toBe('leaf')
    }, 15_000)

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

    it('rejects a non-lossless completion instead of replacing it with rendered text', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'return { f: () => 1 }', bindings: [] })
      expect(result.value).toBeUndefined()
      expect(result.error).toEqual({ kind: 'invalid-output', message: 'program completion must be lossless JSON' })
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
      expect(result.logs).toContain('before')
    })
  })

  describe(`${label} — budgets and containment (real workers)`, () => {
    it('ends a hot loop at the compute budget — including behind a pending decoy dispatch', async () => {
      const { runtime } = await setup({ computeMs: 300, maxWallMs: 30_000 })
      const result = await runtime.run({
        // The decoy: fire a call at a never-resolving binding WITHOUT awaiting,
        // then spin. Host-side pending-call bookkeeping would pause a naive
        // budget here; measured busy time cannot be fooled.
        program: 'void tools.slow({}); for (;;) {}',
        bindings: workerRuntimeTools({ slow: () => new Promise(() => {}) }),
      })
      expect(result.error?.kind).toBe('timeout')
      expect(result.error?.message).toContain('compute budget')
    }, 15_000)

    it('does not charge time spent awaiting a slow binding against the compute budget', async () => {
      // Keep the binding delay above the compute allowance while leaving enough
      // headroom for worker bootstrap on loaded CI hosts.
      const { runtime } = await setup({ computeMs: 1_000, maxWallMs: 30_000 })
      const result = await runtime.run({
        program: 'return await tools.slow({})',
        bindings: workerRuntimeTools({ slow: () => new Promise(resolve => setTimeout(() => { resolve('slow-done') }, 1_500)) }),
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe('slow-done')
    }, 15_000)

    it('ends an idle-forever run at the wall-clock ceiling', async () => {
      const { runtime } = await setup({ computeMs: 30_000, maxWallMs: 400 })
      const result = await runtime.run({
        program: 'await tools.never({}); return 1',
        bindings: workerRuntimeTools({ never: () => new Promise(() => {}) }),
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

    it('applies the outer-output cap to failures before worker startup', async () => {
      const capped = await setup({ maxOutputBytes: 64 })
      const controller = new AbortController()
      controller.abort('A'.repeat(1_000))
      const aborted = await capped.runtime.run({ program: 'return 1', bindings: [], signal: controller.signal })
      expect(aborted).toEqual({ logs: [], error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' } })

      const minimal = await setup({ maxOutputBytes: 4 })
      const invalid = await minimal.runtime.run({ program: 'enum E { A }\nreturn 1', bindings: [] })
      expect(invalid.error?.kind).toBe('output-limit')
      expect(Buffer.byteLength(JSON.stringify(invalid.logs), 'utf8') + Buffer.byteLength(JSON.stringify(invalid.error?.message), 'utf8')).toBeLessThanOrEqual(4)
    })

    it('drops a binding resolution that lands after the run settled', async () => {
      const { runtime } = await setup()
      const controller = new AbortController()
      let replyDelivered!: Promise<void>
      const result = await runtime.run({
        program: 'void tools.late({}); for (;;) {}',
        bindings: workerRuntimeTools({
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

    it('reports a worker that exits before publishing a completion', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'process.exit(7)', bindings: [] })
      expect(result).toEqual({
        logs: [],
        error: { kind: 'worker-exit', message: 'worker exited with code 7 before completing' },
      })
    })

    it('fails runaway log output explicitly while retaining a bounded prefix', async () => {
      const { runtime } = await setup({ maxOutputBytes: 300 })
      const result = await runtime.run({
        program: 'for (let i = 0; i < 1000; i++) console.log("spam line", i); return 1',
        bindings: [],
      })
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 300 bytes' })
      expect(result.value).toBeUndefined()
      expect(result.logs.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8')).toBeLessThan(300)
    })

    it('retains a fitting prefix when one oversized log is the first output', async () => {
      const { runtime } = await setup({ maxOutputBytes: 96 })
      const result = await runtime.run({
        program: 'console.log(`start-${`😀"\\\\\\n`.repeat(100)}`); return null',
        bindings: [],
      })
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 96 bytes' })
      expect(result.logs).toHaveLength(1)
      expect(result.logs[0]?.startsWith('start-')).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
        + Buffer.byteLength(JSON.stringify(result.error?.message), 'utf8')).toBeLessThanOrEqual(96)
    })

    it('fails an oversized return value without substituting a string', async () => {
      const { runtime } = await setup({ maxOutputBytes: 64 })
      const result = await runtime.run({ program: 'return "y".repeat(10_000)', bindings: [] })
      expect(result.value).toBeUndefined()
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 64 bytes' })
    })

    it('uses UTF-8 serialized bytes at the exact completion boundary', async () => {
      const exact = await setup({ maxOutputBytes: 7 })
      const exactResult = await exact.runtime.run({ program: 'return "€"', bindings: [] })
      // [] costs two bytes and JSON serialization of "€" costs five.
      expect(exactResult).toEqual({ logs: [], value: '€' })

      const over = await setup({ maxOutputBytes: 6 })
      const overResult = await over.runtime.run({ program: 'return "€"', bindings: [] })
      expect(overResult.error?.kind).toBe('output-limit')
    })

    it('accounts logs and completion in one exact combined ledger', async () => {
      // JSON(["abc"]) is seven bytes and JSON("xy") is four.
      const exact = await setup({ maxOutputBytes: 11 })
      expect(await exact.runtime.run({ program: 'console.log("abc"); return "xy"', bindings: [] }))
        .toEqual({ logs: ['abc'], value: 'xy' })

      const over = await setup({ maxOutputBytes: 10 })
      const result = await over.runtime.run({ program: 'console.log("abc"); return "xy"', bindings: [] })
      expect(result.value).toBeUndefined()
      expect(result.error?.kind).toBe('output-limit')
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8') + Buffer.byteLength(JSON.stringify(result.error?.message), 'utf8')).toBeLessThanOrEqual(10)
    })

    it('accounts logs and exception diagnostics before the worker port boundary', async () => {
      // JSON(["abc"]) is seven bytes and JSON("xy") is four.
      const exact = await setup({ maxOutputBytes: 11 })
      expect(await exact.runtime.run({ program: 'console.log("abc"); throw "xy"', bindings: [] }))
        .toEqual({ logs: ['abc'], error: { kind: 'exception', message: 'xy' } })

      const over = await setup({ maxOutputBytes: 10 })
      const result = await over.runtime.run({ program: 'console.log("abc"); throw "xy"', bindings: [] })
      expect(result.error?.kind).toBe('output-limit')
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
        + Buffer.byteLength(JSON.stringify(result.error?.message), 'utf8')).toBeLessThanOrEqual(10)
    })

    it('does not send a giant Error stack across the worker port', async () => {
      const { runtime } = await setup({ maxOutputBytes: 64 })
      const result = await runtime.run({
        program: 'throw new Error("x".repeat(1_000_000))',
        bindings: [],
      })
      expect(result).toEqual({
        logs: [],
        error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
      })
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
      expect(result.logs).toContain('flushed')
    })

    it('returns a large JSON container exactly when the outer cap permits it', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'return new Array(50_000).fill(7)', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual(new Array(50_000).fill(7))
    })

    it('returns an exact completion at the default 64 MiB combined boundary', async () => {
      const { runtime } = await setup()
      // [] costs two bytes and the JSON string contributes two quotes, leaving
      // exactly this many payload bytes under the 67_108_864-byte default.
      const result = await runtime.run({ program: 'return "x".repeat(67_108_860)', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.logs).toEqual([])
      expect(result.value).toHaveLength(67_108_860)
    }, 60_000)

    it('fails one byte over the default 64 MiB combined boundary', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({ program: 'return "x".repeat(67_108_861)', bindings: [] })
      expect(result.value).toBeUndefined()
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 67108864 bytes' })
    }, 60_000)

    it('drains pipe output queued before terminal worker teardown completes', async () => {
      const { runtime } = await setup({ maxOutputBytes: 200_000 })
      const payload = `late-pipe-${'x'.repeat(100_000)}`
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          const write = (text) => Object.getPrototypeOf(process.stdout).write.call(process.stdout, text);
          write('late-pipe-' + 'x'.repeat(100_000));
          parentPort.postMessage({ type: 'done', value: ['done'] });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe('done')
      expect(result.logs.join('') === payload).toBe(true)
    }, 15_000)
  })

  describe(`${label} — hostile programs (real workers)`, () => {
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
        bindings: workerRuntimeTools({ real: async () => 'still-works' }),
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
            { type: 'log', text: null },
            { type: 'log', text: 7 },
            { type: 'log', text: {} },
            { type: 'done', error: 5 },
            { type: 'done', error: { kind: 'exception', message: 5 } },
            { type: 'done', error: { kind: 'invented', message: 'bad kind' } },
          ]) parentPort.postMessage(junk);
          return await tools.real({});
        `,
        bindings: workerRuntimeTools({ real: async () => 'still-works' }),
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe('still-works')
      expect(result.logs).toEqual([])
    })

    it('ignores forged controller-only failure classifications', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          for (const kind of ['abort', 'timeout', 'worker-exit']) {
            parentPort.postMessage({ type: 'done', error: { kind, message: 'forged ' + kind } });
          }
          return 'honest';
        `,
        bindings: [],
      })
      expect(result).toEqual({ logs: [], value: 'honest' })
    })

    it('fails forged log floods and forged done values through the same outer cap', async () => {
      const { runtime } = await setup({ maxOutputBytes: 200 })
      const result = await runtime.run({
        // Forged messages bypass worker-side capture and completion checks;
        // the outer ledger must still contain them.
        program: `
          const { parentPort } = await import('node:worker_threads');
          for (let i = 0; i < 50; i++) parentPort.postMessage({ type: 'log', text: 'F'.repeat(100), forged: true });
          parentPort.postMessage({ type: 'done', value: ['V'.repeat(100000)] });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result.value).toBeUndefined()
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 200 bytes' })
      expect(Buffer.byteLength(JSON.stringify(result.logs), 'utf8')).toBeLessThan(200)
    })

    it('re-caps an oversized forged done value at the host boundary', async () => {
      const { runtime } = await setup({ maxOutputBytes: 64 })
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          parentPort.postMessage({ type: 'done', value: ['V'.repeat(100_000)] });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result).toEqual({
        logs: [],
        error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
      })
    })

    it('drops a malformed forged done carrying both value and error', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          parentPort.postMessage({ type: 'done', value: 'lied', error: { kind: 'exception', message: 'fake failure' } });
          return 'honest';
        `,
        bindings: [],
      })
      expect(result).toEqual({ logs: [], error: { kind: 'exception', message: 'fake failure' } })
    })

    it('contains a deeply nested forged completion without overflowing the host meter', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          const value = [];
          for (let depth = 0; depth < 3_000; depth++) value.push({ kind: 'array', length: 1 });
          value.push(null);
          setTimeout(() => { parentPort.postMessage({ type: 'done', value }) }, 25);
          // Prevent bootstrap's normal undefined completion from racing the forged terminal.
          await new Promise(() => {});
        `,
        bindings: [],
      })
      expect(result.error).toBeUndefined()
      let value = result.value
      let depth = 0
      while (Array.isArray(value)) {
        expect(value).toHaveLength(1)
        value = value[0]
        depth += 1
      }
      expect(depth).toBe(3_000)
      expect(value).toBeNull()
    }, 15_000)

    it('turns forged over-limit error text into output-limit at the host', async () => {
      const { runtime } = await setup({ maxOutputBytes: 64 })
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          parentPort.postMessage({ type: 'done', error: { kind: 'exception', message: '€'.repeat(1000) } });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 64 bytes' })
    })

    it('answers a binding whose resolution is not lossless JSON with a typed failure reply', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: 'try { await tools.bad({}) } catch (error) { return { name: error.name, toolName: error.toolName, message: error.message } }',
        bindings: workerRuntimeTools({ bad: async () => (() => 1) }),
      })
      expect(result.value).toEqual({ name: 'ToolCallError', toolName: 'bad', message: 'binding resolution must be lossless JSON' })
    })

    it('rejects lossy binding arguments in the worker before invoking the host binding', async () => {
      const { runtime } = await setup()
      let calls = 0
      const result = await runtime.run({
        program: `
          const decorated = [1]; Object.defineProperty(decorated, 'extra', { value: true });
          const values = [new Date(), decorated, () => 1];
          const failures = [];
          for (const value of values) {
            try { await tools.never(value) } catch (error) {
              failures.push({ typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message });
            }
          }
          return failures;
        `,
        bindings: workerRuntimeTools({ never: async () => { calls += 1; return null } }),
      })
      expect(calls).toBe(0)
      expect(result.value).toEqual(new Array(3).fill({
        typed: true,
        name: 'ToolCallError',
        toolName: 'never',
        message: 'binding arguments must be lossless JSON',
      }))
    })

    it('rejects intrinsic-looking exotic objects as arguments and completions', async () => {
      const { runtime } = await setup()
      let calls = 0
      const forgeObject = `
        const prototype = Object.create(null);
        const SpoofedObject = function Object() {};
        SpoofedObject.prototype = prototype;
        Object.defineProperty(prototype, 'constructor', { value: SpoofedObject });
        const forged = Object.assign(Object.create(prototype), { value: 1 });
        Function.prototype.toString = () => 'function Object() { [native code] }';
      `
      const argument = await runtime.run({
        program: `${forgeObject}
          try { await tools.never(forged) } catch (error) {
            return { typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message };
          }
        `,
        bindings: workerRuntimeTools({ never: async () => { calls += 1; return null } }),
      })
      expect(calls).toBe(0)
      expect(argument.value).toEqual({
        typed: true,
        name: 'ToolCallError',
        toolName: 'never',
        message: 'binding arguments must be lossless JSON',
      })

      const completion = await runtime.run({ program: `${forgeObject}\nreturn forged`, bindings: [] })
      expect(completion).toEqual({
        logs: [],
        error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
      })
    })

    it('preserves binding and completion JSON after model code mutates boundary globals', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const arrayPrototype = Array.prototype;
          const objectPrototype = Object.prototype;
          const setPrototype = Set.prototype;
          const stringPrototype = String.prototype;
          Array.isArray = () => false;
          arrayPrototype.at = arrayPrototype.includes = arrayPrototype.pop = arrayPrototype.push = () => { throw new Error('mutated array method') };
          Object.defineProperty = Object.getOwnPropertyDescriptor = Object.getPrototypeOf = Object.keys = () => { throw new Error('mutated object method') };
          Object.hasOwn = () => false;
          Object.is = () => true;
          objectPrototype.propertyIsEnumerable = () => false;
          Number.isFinite = Number.isSafeInteger = () => false;
          Reflect.apply = Reflect.ownKeys = () => { throw new Error('mutated reflect method') };
          setPrototype.add = setPrototype.delete = setPrototype.has = () => { throw new Error('mutated set method') };
          stringPrototype.charCodeAt = stringPrototype.codePointAt = stringPrototype.slice = () => { throw new Error('mutated string method') };
          Buffer.byteLength = () => 0;
          Function.prototype.toString = () => 'mutated';
          objectPrototype.get = () => undefined;
          objectPrototype.constructor = arrayPrototype.constructor = null;
          globalThis.Array = globalThis.Buffer = globalThis.Error = globalThis.Function = globalThis.Number = globalThis.Object = globalThis.Reflect = globalThis.Set = globalThis.String = undefined;
          const echoed = await tools.echo({ request: ['€', 1] });
          let failure;
          try { await tools.fail({}) } catch (error) {
            failure = { typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message };
          }
          return { echoed, failure, completion: { ok: true, amount: 42 } };
        `,
        bindings: workerRuntimeTools({ echo: async args => args, fail: async () => { throw new Error('nope') } }),
      })
      expect(result).toEqual({
        logs: [],
        value: {
          echoed: { request: ['€', 1] },
          failure: { typed: true, name: 'ToolCallError', toolName: 'fail', message: 'nope' },
          completion: { ok: true, amount: 42 },
        },
      })
    })

    it('rejects forged lossy binding arguments again at the host boundary', async () => {
      const { runtime } = await setup()
      let calls = 0
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          const forged = (id, args) => new Promise((resolve) => {
            const receive = (message) => {
              if (message?.type !== 'reply' || message.id !== id) return;
              parentPort.off('message', receive);
              resolve(message);
            };
            parentPort.on('message', receive);
            parentPort.postMessage({ type: 'call', id, global: 'tools', name: 'never', args });
          });
          const sparse = []; sparse.length = 1;
          const cycle = {}; cycle.self = cycle;
          return await Promise.all([
            forged(8001, new Date()),
            forged(8002, -0),
            forged(8003, sparse),
            forged(8004, cycle),
          ]);
        `,
        bindings: workerRuntimeTools({ never: async () => { calls += 1; return null } }),
      })
      expect(calls).toBe(0)
      expect(result.value).toEqual([8001, 8002, 8003, 8004].map(id => ({
        type: 'reply',
        id,
        ok: false,
        message: 'binding arguments must be lossless JSON',
      })))
    })

    it('contains throwing getters while snapshotting binding resolutions', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: 'try { await tools.bad({}) } catch (error) { return { name: error.name, toolName: error.toolName, message: error.message } }',
        bindings: workerRuntimeTools({ bad: async () => Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('getter exploded') } }) }),
      })
      expect(result.value).toEqual({ name: 'ToolCallError', toolName: 'bad', message: 'binding resolution must be lossless JSON' })
    })

    it('revalidates a forged lossy completion at the host boundary', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          parentPort.postMessage({ type: 'done', value: -0 });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result).toEqual({ logs: [], error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } })
    })

    it('honors a forged worker-side output-limit signal', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: `
          const { parentPort } = await import('node:worker_threads');
          parentPort.postMessage({ type: 'output-limit' });
          for (;;) {}
        `,
        bindings: [],
      })
      expect(result).toEqual({ logs: [], error: { kind: 'output-limit', message: 'outer output exceeded 67108864 bytes' } })
    })

    it('exposes binding names that collide with Object.prototype as ordinary functions', async () => {
      const { runtime } = await setup()
      const result = await runtime.run({
        program: 'return [await tools["__proto__"]({}), await tools["constructor"]({}), typeof tools["hasOwnProperty"]]',
        // Computed keys: a literal `'__proto__': …` entry would SET the record's
        // prototype instead of declaring a binding of that name.
        bindings: workerRuntimeTools({ ['__proto__']: async () => 'proto-ok', ['constructor']: async () => 'ctor-ok' }),
      })
      expect(result.value).toEqual(['proto-ok', 'ctor-ok', 'undefined'])
    })
  })

  describe(`${label} — seam misuse and lifecycle`, () => {
    it('rejects invalid and duplicate binding globals loudly', async () => {
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

      await expect(runtime.run({
        program: 'return typeof ToolCallError',
        bindings: [{ global: 'ToolCallError', functions: {} }],
      })).resolves.toMatchObject({ value: 'object' })
    })

    it('rejects malformed or colliding binding error-class declarations', async () => {
      const { runtime } = await setup()
      const run = async (bindings: CodeBindingNamespace[]) => await runtime.run({ program: 'return 1', bindings })
      const namespace = (global: string, name: string, memberNameProperty = 'memberName'): CodeBindingNamespace => ({
        global,
        functions: {},
        errorClass: { name, memberNameProperty },
      })

      await expect(run([namespace('tools', 'not valid!')])).rejects.toThrow(/error class.*not a usable identifier/)
      await expect(run([namespace('tools', 'await')])).rejects.toThrow(/error class.*not a usable identifier/)
      await expect(run([namespace('tools', 'console')])).rejects.toThrow(/duplicate injected global/)
      await expect(run([namespace('tools', 'tools')])).rejects.toThrow(/duplicate injected global/)
      await expect(run([
        namespace('tools', 'CallError'),
        namespace('helpers', 'CallError'),
      ])).rejects.toThrow(/duplicate injected global/)
      await expect(run([namespace('tools', 'CallError', '')])).rejects.toThrow(/member property.*not usable/)
      await expect(run([namespace('tools', 'CallError', 'message')])).rejects.toThrow(/member property.*not usable/)
    })

    it('rejects config values that are not positive numbers', async () => {
      await expect(setup({ computeMs: -1 })).rejects.toThrow(/positive number/)
    })

    it('rejects a maxWallMs above Node\'s maximum timer delay', async () => {
      // setTimeout clamps a delay past 2^31-1 ms to 1 ms, so the positivity check
      // alone would accept a 25-day ceiling that expires on the first tick.
      await expect(setup({ maxWallMs: 2_147_483_648 }))
        .rejects.toThrow(/maxWallMs must be at most 2147483647/)
      // The boundary itself is usable.
      await expect(setup({ maxWallMs: 2_147_483_647 })).resolves.toBeTruthy()
    })

    it('requires maxOutputBytes to fit the smallest counted outer payloads', async () => {
      await expect(setup({ maxOutputBytes: 3 })).rejects.toThrow(/safe integer of at least 4/)
      await expect(setup({ maxOutputBytes: 4.5 })).rejects.toThrow(/safe integer of at least 4/)
    })

    it('keeps runs isolated: no state survives from one run to the next', async () => {
      const { runtime } = await setup()
      await runtime.run({ program: 'globalThis.leak = "value"; return 1', bindings: [] })
      const second = await runtime.run({ program: 'return typeof globalThis.leak', bindings: [] })
      expect(second.value).toBe('undefined')
    })

    it('disposal aborts in-flight runs, awaits worker exit, and rejects later runs', async () => {
      const { runtime, dispose } = await setup()
      const inflight: Promise<CodeRunResult> = runtime.run({ program: 'for (;;) {}', bindings: [] })
      // Give the worker a moment to actually start spinning.
      await new Promise(resolve => setTimeout(resolve, 200))
      await dispose()
      const result = await inflight
      expect(result.error).toEqual({ kind: 'abort', message: 'runtime disposed' })
      await expect(runtime.run({ program: 'return 1', bindings: [] })).rejects.toThrow(/after disposal/)
    }, 15_000)
  })
}
