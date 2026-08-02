/**
 * Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
 * Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
 * {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
 * store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
 * runtime's language}.
 *
 * In Code Mode the native tool schemas are omitted from the request, so this generated SDK is
 * the model's ONLY source for each tool's argument names, required fields, types, descriptions,
 * and canonical output shapes. Object-shaped arguments and outputs therefore render as one named
 * `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the shape
 * survives into the program.
 * @module @deepseek-ai/dsh-tools/src/py-types
 */

import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaScalar } from './json-schema.ts'
import type { ToolSdkSchema } from './ts-types.ts'

/** Property names that are valid bare Python identifiers; anything else is subscripted. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Python hard keywords: reserved everywhere, so a tool or field named
 * ``class`` or ``lambda`` is legal on the wire but not as an attribute
 * (``tools.class`` would be a SyntaxError in the model program) and not as a
 * class-syntax `TypedDict` field. Such a tool renders under subscript access
 * and such an object degrades to ``dict[str, Any]`` — the model still reaches
 * every tool and field without collisions.
 * Soft keywords (``match``, ``case``, ``type``, ``_``) are deliberately
 * ABSENT: they are only special in statement position, so ``match: str`` as a
 * field and ``async def match(...)`` as a method are both legal, and including
 * them would needlessly degrade common search/regex tool fields to
 * ``dict[str, Any]``. Underscore-leading names are handled separately (dunders
 * name-mangle or resolve on ``object`` before the proxy hook), not here.
 */
const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
  // Not a keyword, but CPython refuses to ASSIGN it at compile time
  // (`SyntaxError: cannot assign to __debug__`), which is what a TypedDict
  // field, a parameter name, and a keyword argument all are.
  '__debug__',
])

/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = ['Any', 'Literal', 'NotRequired', 'Protocol', 'TypedDict'] as const

/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent: number): string {
  return '    '.repeat(indent)
}

/**
 * Collector threaded through {@link renderType}: the emitted `TypedDict` class
 * declarations (nested classes precede the parent that references them), the
 * class names already taken (for collision suffixing), a per-base collision
 * counter, and the `typing` symbols the render actually used.
 */
interface RenderState {
  readonly classes: string[]
  readonly usedClassNames: Set<string>
  /** Next collision counter per capped base, so allocation is amortized O(1) instead of rescanning from `2`. */
  readonly nextClassCounter: Map<string, number>
  readonly typing: Set<string>
}

/**
 * Control characters that survive the whitespace collapse in {@link describe}
 * and have no printable form. CPython rejects source containing a NUL outright
 * (`SyntaxError: source code string cannot contain null bytes`), whether it
 * sits in a docstring or in a comment, so one such byte anywhere in a schema
 * description would make the whole generated SDK unparseable — the model's only
 * declaration of the tools. The rest are legal but invisible; escaping them
 * with the same rule keeps the emitted text readable and the treatment uniform.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f]/g

/**
 * The collapsed one-line `description` of a schema node (byte-stable across
 * formatting churn), or `undefined` when the node carries none. Every caller
 * passes an object (validated property nodes, or the ToolSdkSchema itself),
 * so only the description field needs guarding.
 *
 * Control characters left over after the whitespace collapse are rendered as
 * their `\xNN` escapes (see {@link UNPRINTABLE}); the escape's own backslash is
 * emitted literally by both consumers, since {@link docLines} doubles it into a
 * Python source escape and a `#` comment carries it verbatim.
 */
function describe(schema: object): string | undefined {
  const description = (schema as Record<string, unknown>).description
  if (typeof description !== 'string' || description.length === 0) return undefined
  return description
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .trim()
}

/**
 * One-line docstring for a tool `description`, or no lines when there is none.
 * Backslashes are doubled first, every quote is escaped, and a trailing
 * backslash cannot survive: a description ending in `"` or an odd backslash
 * would otherwise merge with (or escape) the closing triple quote and make
 * the generated block — Code Mode's only SDK — syntactically invalid Python.
 */
function docLines(description: unknown, indent: number): string[] {
  const collapsed = describe({ description })
  if (collapsed === undefined) return []
  const escaped = collapsed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return [`${pad(indent)}"""${escaped}"""`]
}

/** CamelCase a name into a Python type identifier (non-identifier chars split words; a non-letter head is prefixed). */
function camelCase(raw: string): string {
  const joined = raw
    .split(/[^A-Za-z0-9]+/)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
  return /^[A-Za-z]/.test(joined) ? joined : `Tool${joined}`
}

/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120

/**
 * Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
 * The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
 * derive from their parent's allocated name (`ParentChild`), so an unbounded
 * schema of single-field objects would otherwise grow each name by one field
 * per level and the sum of all names to Θ(depth²). Capping the base keeps each
 * name — and the total emitted text — linear in depth. Collisions resume from
 * the per-base counter in `state.nextClassCounter` rather than rescanning from
 * `2`, so a deep chain sharing one capped base stays O(1) per allocation
 * (amortized) instead of Θ(depth²) in time.
 */
function allocateClassName(base: string, state: RenderState): string {
  const capped = base.length > MAX_CLASS_NAME_BASE ? base.slice(0, MAX_CLASS_NAME_BASE) : base
  let name = capped
  if (state.usedClassNames.has(name)) {
    let n = state.nextClassCounter.get(capped) ?? 2
    while (state.usedClassNames.has(`${capped}${n}`)) n++
    name = `${capped}${n}`
    state.nextClassCounter.set(capped, n + 1)
  }
  state.usedClassNames.add(name)
  return name
}

/**
 * Render one validated scalar as Python literal text (`True`/`False`,
 * JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
 * type renders directly as `None`, and the unified validator rejects a null
 * `const`/`enum` entry on every other scalar type.
 *
 * A beyond-safe-range integral number takes `BigInt` digits rather than
 * `String`: Python integers are arbitrary-precision, so the emitted digits ARE
 * the value the model programs against, and `String` gives a different integer
 * than the double holds (`2 ** 60` prints the rounded `...847000`, not the
 * exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`). The
 * Python runtime then rejects the advertised literal as not exactly
 * representable as a JavaScript number, so the SDK would document a value no
 * program can pass. The TS flavor needs no counterpart: its literal is re-read
 * by a JS parser back into the same double.
 */
function pyScalar(value: JsonSchemaScalar): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/**
 * Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
 * the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
 * parameters to int/bool/str/bytes/enum/None: a number `const`/`enum` emits a
 * float literal (`Literal[1.5]`) a strict checker would reject. Harmless here —
 * the stub is advisory prompt text, only required to parse — and keeping the
 * exact value communicates the constraint to the model.
 */
function renderConstrainedScalar(node: Record<string, unknown>, broad: string, state: RenderState): string {
  if (Object.hasOwn(node, 'const')) {
    state.typing.add('Literal')
    return `Literal[${pyScalar(node.const as JsonSchemaScalar)}]`
  }
  if (Object.hasOwn(node, 'enum')) {
    state.typing.add('Literal')
    return `Literal[${(node.enum as JsonSchemaScalar[]).map(pyScalar).join(', ')}]`
  }
  return broad
}

/**
 * Map one JSON-Schema node to a Python type expression, threading `state` to
 * collect the `TypedDict` declarations and `typing` symbols a full render
 * needs. `className` is the name to give an object node with properties (and
 * the prefix for its nested objects). Handles every unified schema construct —
 * `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
 * `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
 * without throwing, the same trusted-after-validation stance as the sibling
 * {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
 * context-free entry point; this is the collecting core.
 */
function renderType(schema: unknown, className: string, state: RenderState): string {
  interface Frame {
    schema: unknown
    className: string
    phase: 'start' | 'children'
    kind?: 'oneOf' | 'array' | 'typeddict'
    node?: Record<string, unknown>
    children: { schema: unknown; className: string }[]
    childIndex: number
    childTypes: string[]
    entries: [string, unknown][]
    allocated?: string
  }
  const newFrame = (schema: unknown, className: string): Frame =>
    ({ schema, className, phase: 'start', children: [], childIndex: 0, childTypes: [], entries: [] })
  try {
    // Validate the WHOLE tree once, then trust it — the same contract the
    // sibling ts-types renderer follows at a typed same-process seam. Every
    // node past this point is a validated JSON-schema node, so the walk reads
    // its fields without re-checking. An unsupported or malformed schema throws
    // here (before anything is emitted) and degrades to `Any`, the Python
    // counterpart of the TS flavor's `unknown`.
    assertSupportedJsonSchema(schema)
    const frames: Frame[] = [newFrame(schema, className)]
    let result: string | undefined
    /* jscpd:ignore-start -- the explicit-stack walk skeleton deliberately parallels
       ts-types.ts's renderSupportedSchema; the two sibling renderers keep symmetric shapes. */
    const finish = (type: string): void => {
      frames.pop()
      const parent = frames.at(-1)
      if (parent === undefined) result = type
      else parent.childTypes.push(type)
    }

    while (frames.length > 0) {
      const frame = frames.at(-1)
      /* v8 ignore next -- the loop condition guarantees a current frame. */
      if (frame === undefined) break

      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing python render child')
          frame.childIndex++
          frames.push(newFrame(child.schema, child.className))
          continue
        }
        if (frame.kind === 'oneOf') {
          finish(frame.childTypes.join(' | '))
          continue
        }
        /* jscpd:ignore-end */
        if (frame.kind === 'array') {
          // `list[A | B]` needs no parentheses in Python. Array frames always
          // schedule exactly one child, so its type is present.
          /* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
          finish(`list[${frame.childTypes[0] ?? 'Any'}]`)
          continue
        }
        // typeddict: assemble AFTER the children so any nested class this one
        // references is already declared (declaration order = reference order).
        const node = frame.node
        const name = frame.allocated
        /* v8 ignore next -- typeddict frames always set node and allocated at start. */
        if (node === undefined || name === undefined) throw new Error('missing typeddict frame state')
        const required = new Set(Array.isArray(node.required) ? node.required.filter((n): n is string => typeof n === 'string') : [])
        const lines = [`class ${name}(TypedDict):`]
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index]
          const fieldType = frame.childTypes[index]
          /* v8 ignore next -- entries and childTypes correspond one-to-one. */
          if (entry === undefined || fieldType === undefined) throw new Error('missing typeddict field type')
          const [field, fieldSchema] = entry
          // The parent node passed assertSupportedJsonSchema, so every property
          // value is a validated schema node (an object).
          const description = describe(fieldSchema as object)
          if (description !== undefined) lines.push(`${pad(1)}# ${description}`)
          if (required.has(field)) {
            lines.push(`${pad(1)}${field}: ${fieldType}`)
          } else {
            state.typing.add('NotRequired')
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`)
          }
        }
        // TypedDict syntax cannot express openness, so an open object states it
        // in-band: the annotation is advisory either way, and Code Mode omits
        // the native schemas, making this line the model's only signal that
        // extra keys are accepted.
        if (node.additionalProperties !== false) {
          lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`)
        }
        // A closed empty object still needs a class body (`pass`) to be valid
        // Python; the declared emptiness is the information.
        if (lines.length === 1) lines.push(`${pad(1)}pass`)
        state.classes.push(lines.join('\n'))
        finish(name)
        continue
      }

      frame.phase = 'children'
      const node = frame.schema as Record<string, unknown>
      if (Object.hasOwn(node, 'oneOf')) {
        frame.kind = 'oneOf'
        frame.children = (node.oneOf as unknown[]).map((branch, index) => ({ schema: branch, className: `${frame.className}${index + 1}` }))
        continue
      }
      if (!Object.hasOwn(node, 'type')) {
        state.typing.add('Any')
        finish('Any')
        continue
      }
      switch (node.type) {
        case 'string': finish(renderConstrainedScalar(node, 'str', state)); break
        case 'number': finish(renderConstrainedScalar(node, 'float', state)); break
        case 'integer': finish(renderConstrainedScalar(node, 'int', state)); break
        case 'boolean': finish(renderConstrainedScalar(node, 'bool', state)); break
        case 'null': finish('None'); break
        case 'array': {
          if (!Object.hasOwn(node, 'items')) {
            state.typing.add('Any')
            finish('list[Any]')
            break
          }
          // An array of objects names its item type after the array field.
          frame.kind = 'array'
          frame.children = [{ schema: node.items, className: frame.className }]
          break
        }
        case 'object': {
          // A missing `properties` is an empty property map, exactly as the
          // unified validator and the TS renderer read it — NOT an unknown
          // shape. The openness of the resulting empty object is decided below,
          // so a closed empty object still declares an empty TypedDict rather
          // than a permissive `dict[str, Any]`.
          const entries = Object.entries((node.properties ?? {}) as Record<string, unknown>)
          // An empty `className` marks the context-free `jsonSchemaToPy` entry:
          // there is no naming context to declare into, so degrade. A field
          // name that is not a legal Python attribute is inexpressible as a
          // class-syntax `TypedDict` field, so such an object degrades whole.
          // A leading-double-underscore non-dunder field (`__token`) would be
          // NAME-MANGLED inside class syntax (`_ClassName__token`), describing a
          // different JSON key than the registered schema — degrade like any
          // other inexpressible field name.
          if (className === '' || !entries.every(([name]) => IDENTIFIER.test(name) && !RESERVED.has(name) && !(name.startsWith('__') && !name.endsWith('__')))) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          // An OPEN empty object is any dict; a CLOSED empty object declares an
          // empty TypedDict so "no keys accepted" survives into the SDK.
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          frame.kind = 'typeddict'
          frame.node = node
          frame.allocated = allocateClassName(frame.className, state)
          state.typing.add('TypedDict')
          frame.entries = entries
          // frame.allocated was assigned two statements up; the ?? arm is for the type system only.
          /* v8 ignore next -- allocated is always set before children are built. */
          frame.children = entries.map(([field, child]) => ({ schema: child, className: `${frame.allocated ?? ''}${camelCase(field)}` }))
          break
        }
        /* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
        default: {
          state.typing.add('Any')
          finish('Any')
        }
      }
    }
    /* v8 ignore next -- every root frame produces one expression. */
    return result ?? 'Any'
  } catch {
    // An unsupported or malformed schema failed validation (before any
    // emission), or an unreachable internal invariant tripped. Either degrades
    // the node to `Any` rather than crashing prompt assembly — the Python
    // counterpart of the TS flavor's `unknown` fallback.
    state.typing.add('Any')
    return 'Any'
  }
}

/**
 * Map one JSON-Schema node to a context-free Python type expression from the
 * `typing` module. Handles every unified schema construct — `object` (degraded
 * to `dict[str, Any]`: naming a `TypedDict` requires the render context that
 * {@link renderToolsSdkPy} supplies), `const`/`enum` (→ `Literal[...]`),
 * `oneOf` (→ union), `string`/`number`/`integer`/`boolean`/`null`, `array`
 * (`items` → `list[T]`) — and returns `Any` for an unsupported or malformed
 * schema, matching the TS flavor's `unknown` fallback. Type annotations in the
 * emitted SDK are advisory: Python does not enforce them at runtime.
 * @param schema - the JSON-Schema node.
 * @returns the Python type text.
 */
export function jsonSchemaToPy(schema: unknown): string {
  // A throwaway state whose class collector never escapes: an object with
  // properties has nowhere to declare its TypedDict and degrades to
  // dict[str, Any]. renderToolsSdkPy drives the named-TypedDict path.
  return renderType(schema, '', { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set() })
}

/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

Pass \`run_code\` the body of an async Python function (top-level \`await\` and \`return\` both work). Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic names or reserved words: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`

/**
 * Render the full `tools:sdk` prompt section under `runtime.language ===
 * 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
 * per tool argument or output object (and per nested object) and one awaitable
 * method per visible tool on a `Tools` protocol — typed args in, the tool's
 * canonical output value out — with a `tools: Tools` singleton the model calls
 * into. The `typing` import line lists exactly the symbols the render used.
 * Deterministic — tools are emitted in lexicographic name order, and class
 * declarations precede the protocol in that same order (nested classes before
 * the parent that references them), so an unchanged tool set produces
 * byte-identical text across assemblies.
 * @param schemas - the tool schemas plus canonical output schemas to declare
 *   (the caller excludes `run_code` itself).
 * @returns the complete section text.
 */
export function renderToolsSdkPy(schemas: ToolSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const state: RenderState = { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set(['Protocol']) }
  const inlineMembers: string[] = []
  const subscriptMembers: string[] = []
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state)
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state)
    if (IDENTIFIER.test(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith('_')) {
      inlineMembers.push(...docLines(schema.description, 1))
      inlineMembers.push(`${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`)
    } else {
      // Not a legal attribute name — the model reaches it via ``tools[name]``.
      // The stub lists it as a subscript comment (referencing the named
      // TypedDicts too) so a reader sees what is accessible; runtime resolution
      // goes through the proxy's __getitem__.
      subscriptMembers.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`)
      const description = describe(schema)
      if (description !== undefined) subscriptMembers.push(`${pad(1)}#   ${description}`)
    }
  }
  // Subscript entries are COMMENTS, not statements: a class body of only
  // comments fails to parse, so `pass` is required whenever no inline method
  // exists — including the subscript-only tool set.
  const bodyLines = inlineMembers.length > 0
    ? [...inlineMembers, ...subscriptMembers]
    : [`${pad(1)}pass`, ...subscriptMembers]
  const body = bodyLines.join('\n')
  const imports = TYPING_ORDER.filter(symbol => state.typing.has(symbol))
  const classBlock = state.classes.length > 0 ? `${state.classes.join('\n\n')}\n\n` : ''
  const errorDeclaration = 'class ToolCallError(Exception):\n    toolName: str'
  const declaration = `from typing import ${imports.join(', ')}\n\n${errorDeclaration}\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${declaration}\n\`\`\``
}
