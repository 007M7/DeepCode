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
    expect(text).toContain('async def bash(self, args: BashArgs) -> str: ...')
    // Empty-property tools keep the opaque dict (nothing to name).
    expect(text).toContain('# tools["my-mcp.tool"](args: dict[str, Any]) -> str')
    expect(text).toContain('# tools["class"](args: dict[str, Any]) -> str')
    // Fixed instruction lines the model relies on.
    expect(text).toContain('top-level `await`')
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
    expect(text).toContain('async def search(self, args: SearchArgs) -> str: ...')
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
    expect(text).toContain('async def weird_fields(self, args: dict[str, Any]) -> str: ...')
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
    // Lexicographic: `bash` before `my-mcp.tool` (identifier methods first,
    // then subscript comments — the emitter partitions).
    expect(text.indexOf('async def bash')).toBeLessThan(text.indexOf('# tools["my-mcp.tool"]'))
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
    // Identifier method appears without a docstring line above it.
    expect(text).toContain('async def plain(self, args: dict[str, Any]) -> str: ...')
    expect(text).not.toContain('"""')
    // Subscript entry appears without the "#   ..." description follow-up.
    expect(text).toContain('# tools["weird-name"]')
    expect(text.split('\n').every(line => !line.startsWith('    #   '))).toBe(true)
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

  it('renders a deeply nested array schema without exhausting the call stack', () => {
    // The registry supports depth-unbounded schemas; the renderer must not
    // reintroduce a recursion limit during prompt assembly.
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 20000; i++) deep = { type: 'array', items: deep }
    const type = jsonSchemaToPy(deep)
    expect(type.startsWith('list[list[')).toBe(true)
    expect(type.endsWith(']]')).toBe(true)
    expect(type).toContain('str')
    expect(type.length).toBe('list['.length * 20000 + 'str'.length + ']'.repeat(20000).length)
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
    // Both emission sites: the class docstring and the `#` field comment. The
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
  })
})
