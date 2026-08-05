import { describe, expect, it } from 'vitest'
import { jsonSchemaToPy, renderToolsSdkPy } from '@deepseek-ai/dsh-tools/src/py-types.ts'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'

describe('jsonSchemaToPy', () => {
  it('maps the defineTool DSL subset', () => {
    const cases: [unknown, string][] = [
      [{ type: 'string' }, 'str'],
      [{ type: 'number' }, 'float'],
      [{ type: 'boolean' }, 'bool'],
      [{ type: 'string', enum: ['a', 'b'] }, 'Literal["a", "b"]'],
      [{ type: 'array', items: { type: 'number' } }, 'list[float]'],
      [{ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, 'list[Literal["x", "y"]]'],
      [{ type: 'array' }, 'list[Any]'],
      [{ type: 'object' }, 'dict[str, Any]'],
      [{ type: 'object', properties: {} }, 'dict[str, Any]'],
      [{ type: 'object', properties: { x: { type: 'string' } } }, 'dict[str, Any]'],
    ]
    for (const [schema, expected] of cases) {
      expect(jsonSchemaToPy(schema), JSON.stringify(schema)).toBe(expected)
    }
  })

  it('is total: unsupported or hostile constructs degrade to Any, never throw', () => {
    const cases: unknown[] = [
      undefined,
      null,
      42,
      'string-schema',
      {},
      { oneOf: 7 },
      { $ref: '#/defs/x' },
      { type: 'object', properties: 7 },
      { type: 'string', enum: [1, 2] },
      { type: 'string', enum: [] },
    ]
    for (const schema of cases) {
      expect(() => jsonSchemaToPy(schema), JSON.stringify(schema)).not.toThrow()
    }
    expect(jsonSchemaToPy({ type: 'integer' })).toBe('int')
    expect(jsonSchemaToPy({ type: 'string', const: 'fixed' })).toBe('Literal["fixed"]')
    expect(jsonSchemaToPy({ type: 'boolean', const: true })).toBe('Literal[True]')
    expect(jsonSchemaToPy({ type: 'number', const: 1.5 })).toBe('Literal[1.5]')
    expect(jsonSchemaToPy({ type: 'boolean', enum: [false] })).toBe('Literal[False]')
    expect(jsonSchemaToPy({ type: 'null' })).toBe('None')
    expect(jsonSchemaToPy({ oneOf: [{ type: 'string' }, { type: 'null' }] })).toBe('str | None')
    expect(jsonSchemaToPy({ oneOf: [] })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'object', properties: 7 })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'string', enum: [1, 2] })).toBe('Any')
    expect(jsonSchemaToPy({ type: 'string', enum: [] })).toBe('Any')
  })

  it('emits exact digits for a beyond-safe-range integer literal', () => {
    // Python integers are arbitrary-precision, so the emitted digits ARE the
    // value the model programs against. `String(2 ** 60)` prints the rounded
    // ...847000, which is a DIFFERENT integer from the double's exact
    // ...846976 — the Python runtime would reject the advertised literal as
    // not exactly representable as a JavaScript number, so the SDK would
    // document a value no program can pass.
    expect(jsonSchemaToPy({ type: 'integer', const: 2 ** 60 })).toBe('Literal[1152921504606846976]')
    expect(jsonSchemaToPy({ type: 'integer', enum: [2 ** 60, -(2 ** 60)] }))
      .toBe('Literal[1152921504606846976, -1152921504606846976]')
    // `String(1e21)` prints `1e+21`, not a Python integer literal at all. The
    // rule keys off the VALUE, not the declared type, so a `number` const that
    // happens to be an integral double is spelled the same exact way (both
    // spellings denote the same double, and only the digits also denote the
    // same Python integer).
    expect(jsonSchemaToPy({ type: 'integer', const: 1e21 })).toBe('Literal[1000000000000000000000]')
    expect(jsonSchemaToPy({ type: 'number', const: 1e21 })).toBe('Literal[1000000000000000000000]')
    // Within the safe range, and for non-integral numbers, the plain spelling
    // is already exact and stays unchanged.
    expect(jsonSchemaToPy({ type: 'integer', const: 2 ** 53 - 1 })).toBe('Literal[9007199254740991]')
    expect(jsonSchemaToPy({ type: 'number', const: 1e-7 })).toBe('Literal[1e-7]')
  })
})

describe('renderToolsSdkPy', () => {
  const bash: ToolSdkSchema = {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: parameterSchemaSpecToJsonSchema({ command: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }
  const exotic: ToolSdkSchema = {
    name: 'my-mcp.tool',
    description: 'Exotic name.',
    parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }
  const reserved: ToolSdkSchema = {
    name: 'class',
    description: 'Uses a reserved Python word.',
    parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
    output: { type: 'string' },
  }

  it('declares identifier tools as async methods and lists exotic/reserved names as subscript comments', () => {
    const text = renderToolsSdkPy([exotic, bash, reserved])
    expect(text).toContain('class Tools(Protocol):')
    // The argument object is a named TypedDict, not an opaque dict.
    expect(text).toContain('class BashArgs(TypedDict):')
    expect(text).toContain('async def bash(self, args: BashArgs) -> str:')
    // Empty-property tools keep the opaque dict (nothing to name).
    expect(text).toContain('# tools["my-mcp.tool"](args: dict[str, Any]) -> str')
    expect(text).toContain('# tools["class"](args: dict[str, Any]) -> str')
    // Fixed instruction lines the model relies on.
    expect(text).toContain('top-level `await`')
    // The binding boundary: `tools`/`ToolCallError` are bound, the TypedDicts
    // are not. Both halves are pinned — dropping either one turns a correct
    // contract into a wrong one (a model that reads only "STATIC STUB" would
    // stop catching `ToolCallError`).
    expect(text).toContain('exactly two of the names declared below are bound: `tools` and `ToolCallError`')
    expect(text).toContain('never `FooArgs(field=1)`, which raises `NameError`')
    expect(text).toContain('ToolCallError')
    expect(text).toContain('class ToolCallError(Exception):')
    expect(text).toContain('MAY overlap under `asyncio.gather`')
    expect(text).toContain('lossless JSON')
    expect(text).toContain('```python')
    expect(text).toContain('tools: Tools')
  })

  it('renders required as plain fields and optional as NotRequired, with per-field description comments', () => {
    const tool: ToolSdkSchema = {
      name: 'search',
      description: 'Search for text.',
      parameters: parameterSchemaSpecToJsonSchema({
        query: { type: 'string', required: true, description: 'What to search for.' },
        limit: { type: 'number', description: 'Max results.' },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class SearchArgs(TypedDict):')
    expect(text).toContain('    # What to search for.')
    expect(text).toContain('    query: str')
    expect(text).toContain('    # Max results.')
    expect(text).toContain('    limit: NotRequired[float]')
    expect(text).toContain('async def search(self, args: SearchArgs) -> str:')
    // NotRequired is imported because an optional field used it; Any is NOT,
    // since every type here is concrete — the import line lists only what ran.
    expect(text).toContain('from typing import NotRequired, Protocol, TypedDict')
  })

  it('prefixes Tool when a name CamelCases to a non-letter head, and degrades a malformed schema to Any', () => {
    const tool: ToolSdkSchema = {
      name: '1st-tool', // subscript path; CamelCases to "1stTool" → prefixed "Tool1stTool"
      description: 'Hostile-shape probe.',
      // Malformed node: the unified schema validator rejects it whole, so the
      // args position degrades to Any (registration would refuse this schema;
      // the renderer just must not throw on it).
      parameters: { type: 'object', properties: { field: { type: 'string', description: 42 } } },
      output: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('# tools["1st-tool"](args: Any) -> Tool1stToolOutput')
    expect(text).toContain('class Tool1stToolOutput(TypedDict):')
    expect(text).toContain('    ok: bool')
  })

  it('treats every field as optional when the object carries no required array', () => {
    const tool: ToolSdkSchema = {
      name: 'all_optional',
      description: 'No required array.',
      parameters: { type: 'object', properties: { flag: { type: 'boolean' } } },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('    flag: NotRequired[bool]')
  })

  it('renders an enum inside an object property as a Literal field', () => {
    const tool: ToolSdkSchema = {
      name: 'mode_tool',
      description: 'Pick a mode.',
      parameters: parameterSchemaSpecToJsonSchema({
        mode: { type: 'string', required: true, enum: ['fast', 'slow'] },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class ModeToolArgs(TypedDict):')
    expect(text).toContain('    mode: Literal["fast", "slow"]')
    expect(text).toContain('from typing import Literal, Protocol, TypedDict')
  })

  it('renders one level of nested object as its own named TypedDict declared before the parent', () => {
    const tool: ToolSdkSchema = {
      name: 'workflow',
      description: 'Run a workflow.',
      parameters: parameterSchemaSpecToJsonSchema({
        meta: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: 'Identity block.',
          properties: {
            name: { type: 'string', required: true, description: 'Short name.' },
            phases: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { title: { type: 'string', required: true, description: 'Phase title.' } },
              },
            },
          },
        },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    // Nested class for the `meta` object, and a further nested class for the
    // array item object, each named after its field path.
    expect(text).toContain('class WorkflowArgsMeta(TypedDict):')
    expect(text).toContain('class WorkflowArgsMetaPhases(TypedDict):')
    expect(text).toContain('    meta: WorkflowArgsMeta')
    expect(text).toContain('    phases: NotRequired[list[WorkflowArgsMetaPhases]]')
    // Dependency-before-dependent: the item class precedes its container,
    // which precedes the top-level args class, which precedes the protocol.
    expect(text.indexOf('class WorkflowArgsMetaPhases')).toBeLessThan(text.indexOf('class WorkflowArgsMeta(TypedDict):'))
    expect(text.indexOf('class WorkflowArgsMeta(TypedDict):')).toBeLessThan(text.indexOf('class WorkflowArgs(TypedDict):'))
    expect(text.indexOf('class WorkflowArgs(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
  })

  it('renders a oneOf of object branches as a union of named TypedDicts declared before the parent', () => {
    const tool: ToolSdkSchema = {
      name: 'act',
      description: 'Union output.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          { type: 'object', additionalProperties: false, properties: { err: { type: 'string' } }, required: ['err'] },
        ],
      },
    }
    const text = renderToolsSdkPy([tool])
    // Each object branch becomes its own named class (`${base}Output1/2`),
    // declared before the protocol references the union.
    expect(text).toContain('class ActOutput1(TypedDict):')
    expect(text).toContain('class ActOutput2(TypedDict):')
    expect(text).toContain('-> ActOutput1 | ActOutput2')
    expect(text.indexOf('class ActOutput1(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
    expect(text.indexOf('class ActOutput2(TypedDict):')).toBeLessThan(text.indexOf('class Tools(Protocol):'))
  })

  it('degrades a context-free oneOf of object branches to a union of dict[str, Any]', () => {
    // jsonSchemaToPy has no naming context, so each object branch degrades
    // rather than declaring a class.
    const type = jsonSchemaToPy({
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        { type: 'string' },
      ],
    })
    expect(type).toBe('dict[str, Any] | str')
    // Both branches objects, and the same shape reached through an array: the
    // marker is the CALL's className, so a propagated frame name (`1`, the
    // index-derived branch name) does not revive class declaration on a walk
    // that has nowhere to declare into.
    const object = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    expect(jsonSchemaToPy({ oneOf: [object, object] })).toBe('dict[str, Any] | dict[str, Any]')
    expect(jsonSchemaToPy({ type: 'array', items: { oneOf: [object, { type: 'string' }] } })).toBe('list[dict[str, Any] | str]')
  })

  it('suffixes a counter when two tools CamelCase to the same class base', () => {
    const a: ToolSdkSchema = {
      name: 'my-tool',
      description: 'Dash form.',
      parameters: parameterSchemaSpecToJsonSchema({ x: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const b: ToolSdkSchema = {
      name: 'my.tool',
      description: 'Dot form.',
      parameters: parameterSchemaSpecToJsonSchema({ y: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([a, b])
    // Both sanitize to `MyToolArgs`; the second collides and gets a suffix.
    expect(text).toContain('class MyToolArgs(TypedDict):')
    expect(text).toContain('class MyToolArgs2(TypedDict):')
  })

  it('caps class-name length so a deep single-field chain stays linear', () => {
    // Child class names derive from their parent's, so without a cap the sum of
    // names would be Theta(depth^2). MAX_CLASS_NAME_BASE (120) bounds each name.
    const depth = 4000
    let schema: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < depth; i++) {
      schema = { type: 'object', additionalProperties: false, properties: { inner: schema }, required: ['inner'] }
    }
    const tool: ToolSdkSchema = { name: 'deep', description: 'Deep chain.', parameters: schema, output: { type: 'string' } }
    const text = renderToolsSdkPy([tool])
    const longestClassName = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longestClassName).toBeLessThanOrEqual(140)
    expect(text.length).toBeLessThan(depth * 400)
  })

  it('skips an already-taken counter suffix when a sibling object occupies it', () => {
    // `phase` and `Phase` both CamelCase to base `FooArgsPhase`; `phase2`
    // independently takes `FooArgsPhase2`, so `Phase`'s collision scan must
    // advance to `FooArgsPhase3` (exercises the collision-skip loop).
    const obj = (field: string) => ({ type: 'object' as const, additionalProperties: false, properties: { [field]: { type: 'string' } } })
    const tool: ToolSdkSchema = {
      name: 'foo',
      description: 'Sibling objects with colliding class bases.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { phase: obj('a'), phase2: obj('b'), Phase: obj('c') },
        required: ['phase', 'phase2', 'Phase'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class FooArgsPhase(TypedDict):')
    expect(text).toContain('class FooArgsPhase2(TypedDict):')
    expect(text).toContain('class FooArgsPhase3(TypedDict):')
  })

  it('references the named TypedDict from a reserved/subscript tool too', () => {
    const tool: ToolSdkSchema = {
      name: 'class',
      description: 'Reserved word tool.',
      parameters: parameterSchemaSpecToJsonSchema({ value: { type: 'string', required: true } }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('class ClassArgs(TypedDict):')
    expect(text).toContain('# tools["class"](args: ClassArgs) -> str')
  })

  it('degrades an object to dict[str, Any] when a field name is not a legal Python attribute', () => {
    const tool: ToolSdkSchema = {
      name: 'weird_fields',
      description: 'Has an illegal field name.',
      parameters: { type: 'object', properties: { 'a-b': { type: 'string' } } },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toContain('async def weird_fields(self, args: dict[str, Any]) -> str:')
    expect(text).not.toContain('WeirdFieldsArgs')
  })

  it('keeps soft-keyword field names as TypedDict fields (match/case/type are only special in statement position)', () => {
    const tool: ToolSdkSchema = {
      name: 'search',
      description: 'Soft keywords as fields.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          match: { type: 'string' },
          case: { type: 'boolean' },
          type: { type: 'string' },
        },
        required: ['match'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    // The object keeps its shape rather than degrading to dict[str, Any].
    expect(text).toContain('class SearchArgs(TypedDict):')
    expect(text).toContain('match: str')
    expect(text).toContain('case: NotRequired[bool]')
    expect(text).toContain('type: NotRequired[str]')
    expect(text).not.toContain('dict[str, Any]')
  })

  it('declares a closed empty object with omitted properties as an empty TypedDict, not dict[str, Any]', () => {
    // `{ type: 'object', additionalProperties: false }` with no `properties`
    // is a closed empty object — no key accepted — exactly as the validator
    // and the TS renderer read it. It must not degrade to a permissive dict.
    const tool: ToolSdkSchema = {
      name: 'closed',
      description: 'Closed empty object with omitted properties.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { inner: { type: 'object', additionalProperties: false } },
        required: ['inner'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    expect(text).toMatch(/class ClosedArgsInner\(TypedDict\):\n    pass/)
    expect(text).toContain('inner: ClosedArgsInner')
    expect(text).not.toContain('dict[str, Any]')
  })

  it('degrades an open object with omitted properties to dict[str, Any]', () => {
    // An OPEN empty object (default additionalProperties) is any dict.
    const type = jsonSchemaToPy({ type: 'object', properties: {} })
    expect(type).toBe('dict[str, Any]')
    expect(jsonSchemaToPy({ type: 'object' })).toBe('dict[str, Any]')
  })

  it('renders docstrings for descriptions and orders emissions lexicographically', () => {
    const text = renderToolsSdkPy([bash, exotic])
    expect(text).toContain('"""Run a shell command."""')
    // Descriptions on subscript names ride as a comment beside their entry.
    expect(text).toContain('# tools["my-mcp.tool"]')
    expect(text).toContain('#   Exotic name.')
    // Lexicographic: `bash` before `my-mcp.tool`.
    expect(text.indexOf('async def bash')).toBeLessThan(text.indexOf('# tools["my-mcp.tool"]'))
  })

  it('places a docstring as the first statement of its own method body', () => {
    // Python attaches a docstring to a function only when it is that
    // function's first statement. Above the `async def` the first one would
    // document the `Tools` class and every later one would be a dead
    // expression, so each method must open its body with its own docstring.
    const second: ToolSdkSchema = {
      name: 'zzz',
      description: 'Second by name.',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const lines = renderToolsSdkPy([bash, second]).split('\n')
    for (const [name, doc] of [['bash', 'Run a shell command.'], ['zzz', 'Second by name.']]) {
      const signature = lines.findIndex(line => line.startsWith(`${' '.repeat(4)}async def ${name}(`))
      expect(signature).toBeGreaterThan(-1)
      // Ends in `:`, not the `: ...` stub — a docstring IS the whole body.
      expect(lines[signature]?.endsWith(':')).toBe(true)
      expect(lines[signature + 1]).toBe(`${' '.repeat(8)}"""${doc}"""`)
    }
    // No docstring is left floating at class-body indentation.
    expect(lines.filter(line => line.startsWith(`${' '.repeat(4)}"""`))).toEqual([])
  })

  it('orders subscript entries against methods by name, not by member kind', () => {
    // `a-tool` sorts before `z`, so the subscript comment must precede the
    // method: one ordered stream, not methods-then-comments.
    const noArgs = parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>
    const text = renderToolsSdkPy([
      { name: 'z', description: 'Last by name.', parameters: noArgs, output: { type: 'string' } },
      { name: 'a-tool', description: 'First by name.', parameters: noArgs, output: { type: 'string' } },
    ])
    expect(text.indexOf('# tools["a-tool"]')).toBeLessThan(text.indexOf('async def z'))
    // The interleaved comment does not disturb the class body: `z` still parses
    // as the statement that keeps `pass` out.
    expect(text).not.toContain(`${' '.repeat(4)}pass`)
  })

  it('is deterministic: byte-identical output regardless of input order or duplication', () => {
    expect(renderToolsSdkPy([bash, exotic])).toBe(renderToolsSdkPy([exotic, bash]))
    expect(renderToolsSdkPy([bash, bash])).toBe(renderToolsSdkPy([bash, bash]))
  })

  it('renders a pass body and a minimal import for an empty tool set', () => {
    const text = renderToolsSdkPy([])
    expect(text).toContain('class Tools(Protocol):')
    expect(text).toContain('    pass')
    // Nothing but the protocol is used, so the import line is just Protocol.
    expect(text).toContain('from typing import Protocol')
  })

  it('omits the docstring/comment when a schema has no description', () => {
    const undescribedIdentifier: ToolSdkSchema = {
      name: 'plain',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const undescribedExotic: ToolSdkSchema = {
      name: 'weird-name',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([undescribedIdentifier, undescribedExotic])
    // Identifier method appears without a docstring in its body — hence the
    // `: ...` stub, which a documented method replaces with the docstring.
    expect(text).toContain('async def plain(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('"""')
    // Subscript entry appears without the "#   ..." description follow-up.
    expect(text).toContain('# tools["weird-name"]')
    expect(text.split('\n').every(line => !line.startsWith('    #   '))).toBe(true)
    // A whitespace-only description collapses to nothing and is treated as
    // absent: no empty `""""""` docstring, no bare `#   ` line.
    const blank = renderToolsSdkPy([
      { ...undescribedIdentifier, description: ' \t\n ' },
      { ...undescribedExotic, description: '   ' },
    ])
    expect(blank).toBe(text)
  })

  it('marks an open object TypedDict and declares a closed empty object', () => {
    const t: ToolSdkSchema = {
      name: 'openness',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          open: { type: 'object', additionalProperties: true, properties: { x: { type: 'string' } }, required: ['x'] },
          closedEmpty: { type: 'object', additionalProperties: false, properties: {} },
        },
        required: ['open', 'closedEmpty'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    // The open nested object carries the in-band openness note...
    expect(text).toContain('class OpennessArgsOpen(TypedDict):')
    expect(text).toMatch(/class OpennessArgsOpen\(TypedDict\):\n    x: str\n    # Additional keys beyond those declared are allowed\./)
    // ...the closed root does not...
    expect(text).toMatch(/class OpennessArgs\(TypedDict\):\n    open: OpennessArgsOpen\n    closedEmpty: OpennessArgsClosedEmpty\n\n/)
    // ...and a closed EMPTY object declares an empty TypedDict rather than
    // degrading to dict[str, Any] (which would falsely accept any keys).
    expect(text).toMatch(/class OpennessArgsClosedEmpty\(TypedDict\):\n    pass/)
    expect(text).toContain('closedEmpty: OpennessArgsClosedEmpty')
  })

  it('renders a deeply nested array schema without exhausting the call stack, capped at CPython\'s bracket limit', () => {
    // The registry supports depth-unbounded schemas; the renderer must not
    // reintroduce a recursion limit during prompt assembly. It must also not
    // emit more open brackets than CPython's tokenizer accepts (200), so the
    // chain degrades to `Any` at MAX_LIST_NESTING instead of rendering an SDK
    // block that is not valid Python.
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 20000; i++) deep = { type: 'array', items: deep }
    const type = jsonSchemaToPy(deep)
    expect(type.startsWith('list[list[')).toBe(true)
    expect(type.endsWith(']]')).toBe(true)
    // 180 `list[` levels around `Any`, not 20000 around `str`.
    expect(type).toBe(`${'list['.repeat(180)}Any${']'.repeat(180)}`)
    expect(type.split('[').length - 1).toBeLessThan(200)
  })

  it('keeps a chain just under the nesting cap exact, and restarts nesting per TypedDict field', () => {
    // 179 levels still render the real item type: the cap degrades only what
    // would not parse.
    let under: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 179; i++) under = { type: 'array', items: under }
    expect(jsonSchemaToPy(under)).toBe(`${'list['.repeat(179)}str${']'.repeat(179)}`)
    // A field annotation is a fresh logical line, so a 179-deep chain reached
    // THROUGH an object field is unaffected by the depth spent on the object.
    const tool: ToolSdkSchema = {
      name: 'deep_field',
      description: 'Deep array under a field.',
      parameters: { type: 'object', additionalProperties: false, properties: { rows: under }, required: ['rows'] },
      output: { type: 'string' },
    }
    expect(renderToolsSdkPy([tool])).toContain(`    rows: ${'list['.repeat(179)}str${']'.repeat(179)}`)
  })

  it('renders a deeply nested oneOf chain in linear time (no per-level re-materialization)', () => {
    // Each level is a two-branch oneOf whose first branch recurses; joining the
    // accumulated union string at every level would be Theta(depth^2). At this
    // depth the quadratic path (~100,000^2 char copies) blows past vitest's 5s
    // default, so this fails loud on a regression; the `+`/ConsString path is
    // milliseconds. (Guard the depth explicitly so the assertions stay exact.)
    // The resulting chain is intentionally uncapped, unlike list nesting: it is
    // grammatically valid Python at any length, and only CPython's `compile()`
    // recursion would reject it — see the `oneOf` arm in py-types.ts.
    const depth = 100000
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < depth; i++) deep = { oneOf: [deep, { type: 'null' }] }
    const type = jsonSchemaToPy(deep)
    expect(type.startsWith('str | None')).toBe(true)
    expect(type.endsWith(' | None')).toBe(true)
    expect(type.length).toBe('str'.length + ' | None'.length * depth)
  })

  it('names a deep oneOf-of-object chain in linear time (bounded propagated class names)', () => {
    // Every level is a oneOf whose SECOND branch is a named object (a closed
    // empty TypedDict) and whose first branch recurses — so every level has an
    // object node, each propagating a class name one segment longer. Without a
    // propagation cap, allocateClassName slices an ever-longer rope at every
    // level → Theta(depth^2) (~9.5s at this depth, past the 5s default);
    // childClassName caps the base so it stays linear (~ms). Assertions are
    // shape-based but the depth is the tripwire: a regression times out.
    const depth = 60000
    let deep: Record<string, unknown> = { type: 'object', additionalProperties: false, properties: {} }
    for (let i = 0; i < depth; i++) {
      deep = { oneOf: [deep, { type: 'object', additionalProperties: false, properties: {} }] }
    }
    const tool: ToolSdkSchema = { name: 'deep', description: 'Deep oneOf-object chain.', parameters: { type: 'object', additionalProperties: false, properties: { root: deep }, required: ['root'] }, output: { type: 'string' } }
    const text = renderToolsSdkPy([tool])
    // No emitted class name exceeds the cap (plus a short collision suffix).
    const longest = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longest).toBeLessThanOrEqual(140)
    expect(text).toContain('class Tools(Protocol):')
  })

  it('caps the class name for a tool whose name exceeds the base length limit', () => {
    // The root class base is `${CamelCase(name)}Args`; a very long tool name
    // makes it exceed MAX_CLASS_NAME_BASE, so allocateClassName caps it.
    const longName = `x_${'a'.repeat(200)}`
    const tool: ToolSdkSchema = {
      name: longName,
      description: 'Long name.',
      parameters: { type: 'object', additionalProperties: false, properties: { f: { type: 'string' } }, required: ['f'] },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([tool])
    const longest = [...text.matchAll(/^class (\w+)\(TypedDict\):/gm)].reduce((max, m) => Math.max(max, m[1]?.length ?? 0), 0)
    expect(longest).toBeLessThanOrEqual(140)
    expect(text).toContain('class Tools(Protocol):')
  })

  it('emits pass for a subscript-only tool set (comments are not statements)', () => {
    const t: ToolSdkSchema = {
      name: 'my-exotic.tool',
      description: '',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    // The class body must contain a statement before the subscript comments.
    expect(text).toMatch(/class Tools\(Protocol\):\n    pass\n    # tools\["my-exotic\.tool"\]/)
  })

  it('degrades an object whose field would be name-mangled (__token) to dict[str, Any]', () => {
    // Class-syntax TypedDict mangles a leading-double-underscore non-dunder
    // annotation to _ClassName__token — a different JSON key than the schema.
    const t: ToolSdkSchema = {
      name: 'mangler',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __token: { type: 'string' } },
        required: ['__token'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    expect(text).toContain('async def mangler(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('__token:')
    // Dunder-form fields (__meta__) are NOT mangled and stay expressible.
    const dunder: ToolSdkSchema = {
      name: 'dunder',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __meta__: { type: 'string' } },
        required: ['__meta__'],
      },
      output: { type: 'string' },
    }
    expect(renderToolsSdkPy([dunder])).toContain('__meta__: str')
  })

  it('degrades an object with a __debug__ field, which CPython refuses to assign', () => {
    // `__debug__` is a legal identifier and dunder-form, so it clears both the
    // identifier rule and the name-mangling rule, but CPython rejects the
    // annotation at COMPILE time (`SyntaxError: cannot assign to __debug__`) —
    // and this block is Code Mode's only SDK, so it must always parse.
    const t: ToolSdkSchema = {
      name: 'debugger',
      description: '',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { __debug__: { type: 'string' } },
        required: ['__debug__'],
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([t])
    expect(text).toContain('async def debugger(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('__debug__')
  })

  it('routes every underscore-leading tool name to subscript access', () => {
    // `_foo` and `__meta__` are both legal Python attributes, unlike an exotic
    // name or a hard keyword, yet the whole underscore family goes to
    // `tools[name]` under one rule. Only some forms actually break — `__token`
    // name-mangles at the CALL SITE inside the model's own class, and a dunder
    // that exists on `object` (`__class__`) resolves before the proxy's
    // __getattr__ runs — so the family rule is what routes `_foo` and
    // `__meta__`, not a defect in those two names.
    const make = (name: string): ToolSdkSchema => ({
      name,
      description: 'Leading underscore.',
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    })
    const text = renderToolsSdkPy([make('_foo'), make('__meta__'), make('__token')])
    for (const name of ['_foo', '__meta__', '__token']) {
      expect(text).toContain(`# tools[${JSON.stringify(name)}](args: dict[str, Any]) -> str`)
      expect(text).not.toContain(`async def ${name}(`)
    }
    // No method emitted at all, so the class body needs the explicit `pass`.
    expect(text).toContain('    pass\n')
  })

  it('escapes quotes and backslashes in descriptions so the docstring stays valid Python', () => {
    // A description ending in `"` or an odd backslash would otherwise merge
    // with (or escape) the closing triple quote — and this block is Code
    // Mode's only SDK, so it must always parse.
    const make = (description: string): ToolSdkSchema => ({
      name: 'weird',
      description,
      parameters: parameterSchemaSpecToJsonSchema({}) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    })
    const trailingQuote = renderToolsSdkPy([make('ends in a quote"')])
    expect(trailingQuote).toContain(String.raw`"""ends in a quote\""""`)
    const trailingBackslash = renderToolsSdkPy([make('ends in a backslash\\')])
    expect(trailingBackslash).toContain(String.raw`"""ends in a backslash\\"""`)
    const tripleQuote = renderToolsSdkPy([make('contains """ triple quote')])
    expect(tripleQuote).toContain(String.raw`"""contains \"\"\" triple quote"""`)
  })

  it('escapes unprintable control characters, which CPython refuses inside source at all', () => {
    // `compile()` raises `SyntaxError: source code string cannot contain null
    // bytes` for a NUL ANYWHERE in the source text, including inside a string
    // literal or a comment, so a NUL that survives normalization into a
    // docstring or a `#` field comment stops this block — Code Mode's only SDK —
    // from parsing at all. The whitespace collapse does not remove it (a NUL is
    // not whitespace). Rendering it as a visible escape keeps the source
    // parseable and still shows the model what the schema said.
    const make = (description: string): ToolSdkSchema => ({
      name: 'weird',
      description,
      parameters: parameterSchemaSpecToJsonSchema({
        field: { type: 'string', required: true, description },
      }) as unknown as Record<string, unknown>,
      output: { type: 'string' },
    })
    const nul = renderToolsSdkPy([make('before\u0000after')])
    // Both emission sites: the method docstring and the `#` field comment. The
    // docstring's backslash is doubled by the same escaping that keeps a literal
    // backslash from escaping the closing triple quote, so Python parses it back
    // to the visible `\x00` the comment shows directly. Neither carries the byte.
    expect(nul).not.toContain('\u0000')
    expect(nul).toContain(String.raw`"""before\\x00after"""`)
    expect(nul).toContain(String.raw`# before\x00after`)
    // The other C0 controls and DEL escape on the same path. Tab, newline and
    // carriage return never reach it: the whitespace collapse folds them to a
    // space first.
    const others = renderToolsSdkPy([make('bell\u0007esc\u001bdel\u007f')])
    expect(others).toContain(String.raw`bell\x07esc\x1bdel\x7f`)
    expect(renderToolsSdkPy([make('tab\tnewline\ncr\r')])).toContain('"""tab newline cr"""')
    // No C1 control is ECMAScript whitespace (TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus
    // LF/CR/LS/PS), so the collapse folds none of U+0080 to U+009F and the
    // escape is what keeps them out of the docstring, where they would be
    // invisible. NBSP, which IS whitespace, folds instead. Windows-1252 bytes
    // 0x80 to 0x9F decoded as Latin-1 land exactly here.
    const nel = renderToolsSdkPy([make('a\u0085b')])
    expect(nel).not.toContain('\u0085')
    expect(nel).toContain(String.raw`# a\x85b`)
    const c1 = renderToolsSdkPy([make('csi\u009bst\u009cend\u009f')])
    expect(c1).toContain(String.raw`csi\x9bst\x9cend\x9f`)
    expect(renderToolsSdkPy([make('nb\u00a0sp')])).toContain('"""nb sp"""')
    // `Cf` formatting characters pass through by design: `\xNN` cannot address
    // them, and they terminate neither a Python string literal nor a `#`
    // comment, so the block stays parseable with the code point intact.
    expect(renderToolsSdkPy([make('zero\u200bwidth')])).toContain('"""zero\u200bwidth"""')
  })
})
