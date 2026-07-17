import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import { syntaxErrorContext } from '../src/sandbox.ts'
import { call, dummyTool, LISTENER_CODE, REVERSE_TOOL_CODE, setup, text } from './helpers.ts'

/**
 * The `cordis_mount` success/failure family: real plugins land on a genuine
 * cordis fiber tree, their registrations are observable through the real
 * registry/event bus, and every rejection path teaches the fix.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cordis_mount', () => {
  it('mounts a listener plugin that observes real events, tagged-logging through to the host console', async () => {
    const ctx = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await call(ctx, 'cordis_mount', { code: LISTENER_CODE })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('mounted dyn-1 (plugin "change-logger", state: active)')

    // Fire a REAL tools/change by registering a tool; the mounted listener logs.
    ctx.tools.register(dummyTool('trigger_a'))
    expect(log).toHaveBeenCalledWith('[cordis:dyn-1]', 'tools changed')
  })

  it('mounts a bare-function plugin as <anonymous>, and a named function under its name', async () => {
    const ctx = await setup()
    const anonymous = await call(ctx, 'cordis_mount', { code: 'return (ctx) => { ctx.on(\'tools/change\', () => {}) }' })
    expect(anonymous.isError).toBe(false)
    expect(text(anonymous)).toContain('plugin "<anonymous>"')
    const named = await call(ctx, 'cordis_mount', { code: 'return function watcher(ctx) {}' })
    expect(text(named)).toContain('plugin "watcher"')
  })

  it('lets the agent give ITSELF a new tool, immediately callable through the registry', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: REVERSE_TOOL_CODE })
    expect(result.isError).toBe(false)

    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('reverse_text')
    const reversed = await call(ctx, 'reverse_text', { text: 'harness' })
    expect(reversed.isError).toBe(false)
    expect(text(reversed)).toBe('ssenrah')
  })

  it('normalizes a self-made tool\'s result into the host realm, so the session log accepts it', async () => {
    // VM-realm objects fail the session prototype-identity check; normalize them into host JSON.
    const ctx = await setup()
    await call(ctx, 'cordis_mount', { code: REVERSE_TOOL_CODE })
    const reversed = await call(ctx, 'reverse_text', { text: 'harness' })
    expect(isJsonValue({ content: reversed.content, isError: reversed.isError })).toBe(true)
  })

  it('threads the { content, meta } object return form through to the registry result', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'meta-return',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'meta_tool',
              description: 'attaches a private presentation payload',
              parameters: {},
              async execute() {
                return { content: [{ type: 'text', text: 'ok' }], meta: { kind: 'demo' } }
              },
            }))
          },
        }
      `,
    })
    const result = await call(ctx, 'meta_tool', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ok')
    expect(result.meta).toEqual({ kind: 'demo' })
  })

  it.each([
    ['a bare string', 'return \'ok\'', '"ok"'],
    ['an object whose content is a string', 'return { content: \'ok\' }', '{"content":"ok"}'],
    ['an array of non-objects', 'return [\'ok\']', '["ok"]'],
    ['blocks missing the type tag', 'return [{ text: \'hi\' }]', '[{"text":"hi"}]'],
    ['object-form blocks missing the type tag', 'return { content: [{ text: \'hi\' }] }', '{"content":[{"text":"hi"}]}'],
    ['undefined — a forgotten return', 'return undefined', 'undefined'],
  ])('rejects an execute return of %s as that one call\'s teaching error', async (_label, returnStatement, preview) => {
    // The registry spreads result.content, so { content: 'ok' } would become ['o','k']; reject
    // it as this call's error before it corrupts the next request.
    const ctx = await setup()
    await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'bad-return',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'bad_return_tool',
              description: 'returns a wrong shape',
              parameters: {},
              async execute() { ${returnStatement} },
            }))
          },
        }
      `,
    })
    const result = await call(ctx, 'bad_return_tool', {})
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]!.type).toBe('text')
    expect(text(result)).toContain(`execute returned ${preview}`)
    expect(text(result)).toContain('must return an ARRAY of content blocks')
    expect(text(result)).toContain('✓ return { content: [{ type: \'text\', text: someString }], meta: anyJsonValue }')
  })

  it('truncates a huge invalid execute return in the teaching error', async () => {
    const ctx = await setup()
    await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'huge-return',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'huge_return_tool',
              description: 'returns a huge wrong shape',
              parameters: {},
              async execute() { return 'x'.repeat(500) },
            }))
          },
        }
      `,
    })
    const result = await call(ctx, 'huge_return_tool', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('…')
    expect(text(result)).not.toContain('x'.repeat(200))
  })

  it('accepts a JSON-Schema-style parameters wrapper and normalizes it to the DSL', async () => {
    // These common JSON-Schema spellings each have one DSL meaning, so normalize rather than
    // consume another model turn with a rejection.
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'json-schema-tool',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'json_schema_tool',
              description: 'written in the JSON-Schema dialect',
              parameters: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'the text' },
                  count: { type: 'integer', default: 1 },
                  mode: { type: 'string', enum: ['fast', 'slow'] },
                  extra: { type: 'string', required: false },
                },
                required: ['text'],
              },
              async execute(args) { return [{ type: 'text', text: args.text + ':' + (args.count ?? 0) }] },
            }))
          },
        }
      `,
    })
    expect(result.isError).toBe(false)

    // The registered schema is canonical JSON Schema derived from the DSL:
    // the required array survived, integer became number, extra is optional.
    const schema = ctx.tools.schemas().find(s => s.name === 'json_schema_tool')!
    const parameters = schema.parameters as { properties: Record<string, { type: string; enum?: string[] }>; required?: string[] }
    expect(parameters.required).toEqual(['text'])
    expect(parameters.properties.count!.type).toBe('number')
    expect(parameters.properties.mode!.enum).toEqual(['fast', 'slow'])
    // Arg validation enforces the normalized spec: text required, extra not.
    expect((await call(ctx, 'json_schema_tool', { count: 2 })).isError).toBe(true)
    expect(text(await call(ctx, 'json_schema_tool', { text: 'ok', count: 2 }))).toBe('ok:2')
  })

  it('normalizes a nested object property carrying a JSON-Schema required array', async () => {
    // On an object PROPERTY, a JSON-Schema-style `required` array names the
    // required children — the nested unwrap converts it just like the top level.
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'nested-json-schema',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'nested_json_schema_tool',
              description: 'nested dialect',
              parameters: {
                cfg: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
              },
              async execute(args) { return [{ type: 'text', text: args.cfg.label }] },
            }))
          },
        }
      `,
    })
    expect(result.isError).toBe(false)
    const schema = ctx.tools.schemas().find(s => s.name === 'nested_json_schema_tool')!
    const cfg = (schema.parameters as { properties: { cfg: { required?: string[] } } }).properties.cfg
    expect(cfg.required).toEqual(['label'])
    expect(text(await call(ctx, 'nested_json_schema_tool', { cfg: { label: 'hi' } }))).toBe('hi')
  })

  it.each([
    ['parameters: 42', 'must be a SchemaSpec object'],
    ['parameters: { text: 42 }', 'parameters.text must be a SchemaSpec property object'],
    ['parameters: { text: { type: \'str\' } }', 'parameters.text must declare a valid type: \'string\' | \'number\' | \'boolean\' | \'object\' | \'array\' (got "str")'],
    ['parameters: { text: { type: \'string\', required: \'yes\' } }', 'parameters.text.required must be a boolean when present'],
    ['parameters: { text: { type: \'string\', properties: {} } }', 'parameters.text.properties is only valid for type "object"'],
    ['parameters: { text: { type: \'string\', items: { type: \'string\' } } }', 'parameters.text.items is only valid for type "array"'],
  ])('rejects a malformed SchemaSpec (%s) with a teaching error', async (parameters, message) => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'bad-schema',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'bad_schema_tool',
              description: 'bad',
              ${parameters},
              async execute() { return [] },
            }))
          },
        }
      `,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
  })

  it('accepts a nested object/array SchemaSpec (the DSL recursion)', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'nested-schema',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'nested_schema_tool',
              description: 'nested',
              parameters: {
                item: { type: 'object', required: true, properties: { label: { type: 'string', required: true } } },
                tags: { type: 'array', items: { type: 'string' } },
              },
              async execute(args) { return [{ type: 'text', text: args.item.label }] },
            }))
          },
        }
      `,
    })
    expect(result.isError).toBe(false)
    const echoed = await call(ctx, 'nested_schema_tool', { item: { label: 'ok' }, tags: ['a'] })
    expect(text(echoed)).toBe('ok')
  })

  it('rejects raw dynamic ctx.tools.register calls that bypass harness helpers', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'raw-register',
          inject: ['tools'],
          apply(ctx) {
            ctx.tools.register({
              name: 'raw_dynamic_tool',
              description: 'raw',
              parameters: { type: 'object', properties: {} },
              async execute() { return [] },
            })
          },
        }
      `,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('dynamic tool registration must use a tool returned by harness.defineTool')
    expect(ctx.tools.get('raw_dynamic_tool')).toBeUndefined()
  })

  it('guards the registry reached through ctx.get(\'tools\') identically', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'raw-register-get',
          apply(ctx) {
            ctx.get('tools').register({ name: 'raw_via_get', description: 'raw', parameters: {}, async execute() { return [] } })
          },
        }
      `,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('dynamic tool registration must use a tool returned by harness.defineTool')
    expect(ctx.tools.get('raw_via_get')).toBeUndefined()
  })

  it('passes non-register registry members through the guard with correct binding', async () => {
    const ctx = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'schema-reader',
          inject: ['tools'],
          apply(ctx) {
            console.log('sees', ctx.tools.schemas().length, 'tools; mount is', typeof ctx.tools.get('cordis_mount'))
          },
        }
      `,
    })
    expect(result.isError).toBe(false)
    expect(log).toHaveBeenCalledWith('[cordis:dyn-1]', 'sees', 3, 'tools; mount is', 'object')
  })

  it('keeps a plugin with unsatisfied inject mounted as pending and names what it waits for', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: 'return { name: \'waiter\', inject: [\'no-such-service\'], apply(ctx) {} }',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('state: pending')
    expect(text(result)).toContain('waiting for service(s): no-such-service')
    // Unmounting a pending mount works like any other.
    const unmounted = await call(ctx, 'cordis_unmount', { id: 'dyn-1' })
    expect(unmounted.isError).toBe(false)
  })

  it('rejects code that throws, leaving nothing mounted', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: 'throw new Error(\'boom in sandbox\')' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('boom in sandbox')
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('(no dynamic plugins mounted)')
  })

  it('passes non-Error and null throws through untouched (no SyntaxError misclassification)', async () => {
    const ctx = await setup()
    const primitive = await call(ctx, 'cordis_mount', { code: 'throw \'plain-string-throw\'' })
    expect(primitive.isError).toBe(true)
    expect(text(primitive)).toContain('plain-string-throw')
    const nullish = await call(ctx, 'cordis_mount', { code: 'throw null' })
    expect(nullish.isError).toBe(true)
  })

  it('rejects code that does not return a plugin', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: 'return 42' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must `return` a plugin')
  })

  it('answers a missing return with the two valid plugin forms', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: 'const plugin = (ctx) => {}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('did you forget `return`?')
  })

  it('disposes a plugin whose apply throws, and reports the error', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: 'return { name: \'broken\', apply(ctx) { throw new Error(\'apply exploded\') } }',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('apply exploded')
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('(no dynamic plugins mounted)')
  })

  it('rolls back a plugin that collides with an existing tool name, keeping the original tool intact', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'usurper',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'cordis_mount',
              description: 'dup',
              parameters: {},
              async execute() { return [] },
            }))
          },
        }
      `,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('already registered')
    expect(text(result)).toContain('first cordis_unmount')
    // The original cordis_mount still dispatches — the failed fiber is gone.
    const retry = await call(ctx, 'cordis_mount', { code: LISTENER_CODE })
    expect(retry.isError).toBe(false)
  })

  it('isolates sandbox globals: no process/Buffer, and globalThis writes do not leak to the host', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: `
        globalThis.__cordis_tool_leak = 'leaked'
        return { name: 'probe-' + typeof process + '-' + typeof Buffer, apply(ctx) {} }
      `,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('plugin "probe-undefined-undefined"')
    expect((globalThis as Record<string, unknown>).__cordis_tool_leak).toBeUndefined()
  })

  it.each([
    ['require(\'fs\')', 'require is not available in the mount sandbox', 'inject: [\'fs\']'],
    ['setTimeout(() => {}, 5)', 'setTimeout is not available in the mount sandbox', 'ctx.setTimeout'],
    ['fetch(\'https://example.com\')', 'fetch is not available in the mount sandbox', 'ctx.web'],
  ])('traps the Node API call %s with a redirect to the cordis alternative', async (invocation, trapMessage, redirect) => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: `${invocation}\nreturn (ctx) => {}` })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(trapMessage)
    expect(text(result)).toContain(redirect)
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('(no dynamic plugins mounted)')
  })

  it('lets a mounted plugin schedule through the cordis timer service (inject: [\'timer\'])', async () => {
    const ctx = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'ticker',
          inject: ['timer'],
          apply(ctx) {
            ctx.setTimeout(() => console.log('tick'), 10)
          },
        }
      `,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('state: active')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(log).toHaveBeenCalledWith('[cordis:dyn-1]', 'tick')
  })

  it('provides btoa/atob and the tagged console variants inside the sandbox', async () => {
    const ctx = await setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await call(ctx, 'cordis_mount', {
      code: `
        console.warn('warned')
        console.error('errored')
        const round = atob(btoa('hi'))
        const bytes = new TextEncoder().encode(round)
        return { name: 'codec-' + new TextDecoder().decode(bytes), apply(ctx) { console.log('applied', typeof ctx.on) } }
      `,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('plugin "codec-hi"')
    expect(log).toHaveBeenCalledWith('[cordis:dyn-1]', 'warned')
    expect(log).toHaveBeenCalledWith('[cordis:dyn-1]', 'applied', 'function')
    expect(error).toHaveBeenCalledWith('[cordis:dyn-1]', 'errored')
  })

  it('answers TypeScript syntax in the plain-JS sandbox with the fix', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', {
      code: 'return { name: \'ts\' as const, apply(ctx) {} }',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('plain JavaScript, not TypeScript')
  })

  it('surfaces the offending line + caret and the bracket-balance hint on a syntax error', async () => {
    const ctx = await setup()
    // The canonical model mistake: closing the returned object with `});` as
    // if it were a callback argument. The word "as" in a STRING elsewhere must
    // not trigger the TypeScript hint — the heuristic reads the failing line.
    const result = await call(ctx, 'cordis_mount', {
      code: 'const note = \'treat pattern as regex\'\nreturn {\n  name: \'oops\',\n  apply(ctx) {}\n});',
    })
    expect(result.isError).toBe(true)
    const message = text(result)
    expect(message).toContain('failed to parse')
    expect(message).toContain('});')
    expect(message).toContain('^')
    expect(message).toContain('BODY of an async function')
    expect(message).not.toContain('TypeScript')
  })

  it('syntaxErrorContext falls back to String(error) when the stack has no vm prelude', () => {
    const doctored = new SyntaxError('boom')
    delete (doctored as { stack?: string }).stack
    expect(syntaxErrorContext(doctored)).toBe('SyntaxError: boom')
    const plain = new SyntaxError('bang')
    plain.stack = 'not-a-vm-stack'
    expect(syntaxErrorContext(plain)).toBe('SyntaxError: bang')
  })

  it('handles a runtime-thrown SyntaxError (no source-line prelude) with the generic hint', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'cordis_mount', { code: 'throw new SyntaxError(\'user-crafted\')' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('failed to parse')
    expect(text(result)).toContain('user-crafted')
  })

  it('honors the configured vmTimeoutMs for the synchronous portion', async () => {
    const ctx = await setup({ vmTimeoutMs: 50 })
    const result = await call(ctx, 'cordis_mount', { code: 'while (true) {}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/timed? ?out/i)
    expect(text(await call(ctx, 'cordis_inspect', { what: 'dynamic' }))).toContain('(no dynamic plugins mounted)')
  })

  it('makes instanceof inside the sandbox see BOTH realms (patched vm constructors, host untouched)', async () => {
    // The args a tool's execute receives are HOST-realm objects; without the dual-realm
    // Symbol.hasInstance prelude, `args.items instanceof Array` in sandbox code is silently
    // false.
    const ctx = await setup()
    await call(ctx, 'cordis_mount', {
      code: `
        return {
          name: 'probe-instanceof',
          inject: ['tools'],
          apply(ctx) {
            harness.registerTool(ctx, harness.defineTool({
              name: 'probe_instanceof',
              description: 'report instanceof checks across realms',
              parameters: { items: { type: 'array', required: true, items: { type: 'string' } } },
              async execute(args) {
                const checks = {
                  hostArray: args.items instanceof Array,
                  hostObject: args instanceof Object,
                  vmArray: [] instanceof Array,
                  vmObject: ({}) instanceof Object,
                }
                return [{ type: 'text', text: JSON.stringify(checks) }]
              },
            }))
          },
        }
      `,
    })
    const probed = await call(ctx, 'probe_instanceof', { items: ['a'] })
    expect(probed.isError).toBe(false)
    expect(JSON.parse(text(probed))).toEqual({ hostArray: true, hostObject: true, vmArray: true, vmObject: true })
    // The host realm's constructors keep their default instanceof: no own
    // Symbol.hasInstance was added to them.
    expect(Object.getOwnPropertySymbols(Object)).not.toContain(Symbol.hasInstance)
    expect(Object.getOwnPropertySymbols(Array)).not.toContain(Symbol.hasInstance)
  })
})
