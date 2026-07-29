/**
 * Schema introspection and draft-editing helpers behind the form renderer.
 * The serialized schemastery envelope (`schema.toJSON()`) rehydrates into a
 * live validator whose node relations (`dict`/`inner`/`list`) the renderer
 * walks; drafts are edited immutably by path.
 * @module @deepseek-ai/dsh-client-schema-form/model
 */

import Schema from 'schemastery'

/** Live schemastery node; the renderer reads only its structural relations. */
export type SchemaNode = Schema

/**
 * Rehydrate a serialized schema envelope into a live validator/node tree.
 * @param serialized - `schema.toJSON()` output received over the wire.
 * @returns the root schema node.
 */
export function rehydrateSchema(serialized: unknown): SchemaNode {
  return new Schema(serialized as Schema)
}

/**
 * Validate a draft against a rehydrated schema.
 * @param schema - rehydrated root node.
 * @param draft - candidate value.
 * @returns the validation failure message, or `undefined` when the draft passes.
 */
export function validateDraft(schema: SchemaNode, draft: unknown): string | undefined {
  try {
    ;(schema as unknown as (value: unknown) => unknown)(draft)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The renderable classification of one schema node. */
export type NodeKind =
  | 'object'
  | 'dict'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'union-const'
  | 'unsupported'

/**
 * Classify one node into the renderer's vocabulary. A union renders as a
 * select only when every branch is a literal; everything else the renderer
 * cannot faithfully edit is `unsupported` and falls back to a read-only view
 * (never silently dropped).
 * @param node - live schema node.
 * @returns the control family for this node.
 */
export function nodeKind(node: SchemaNode): NodeKind {
  switch (node.type) {
    case 'object': return 'object'
    case 'dict': return 'dict'
    case 'array': return 'array'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'union':
      return (node.list ?? []).every(branch => branch.type === 'const') ? 'union-const' : 'unsupported'
    default:
      return 'unsupported'
  }
}

/**
 * Literal choices of a `union-const` node, in declaration order.
 * @param node - a node classified `union-const`.
 * @returns each branch's literal value.
 */
export function unionChoices(node: SchemaNode): unknown[] {
  return (node.list ?? []).map(branch => (branch as { value?: unknown }).value)
}

/**
 * Read a nested value by path.
 * @param value - root value (draft or fallback layer).
 * @param path - key path from the root; array indexes as strings.
 * @returns the value at the path, or `undefined` along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Whether a draft explicitly carries the path (its presence marks a user override). */
export function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  const parent = getPath(value, path.slice(0, -1))
  const key = path[path.length - 1] as string
  if (Array.isArray(parent)) return Number(key) < parent.length
  if (typeof parent !== 'object' || parent === null) return false
  return key in parent
}

function cloneContainer(container: unknown, key: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(container)) return [...container as unknown[]]
  if (typeof container === 'object' && container !== null) return { ...container as Record<string, unknown> }
  // A missing intermediate materializes as the container the next key needs.
  return /^\d+$/.test(key) ? [] : {}
}

/**
 * Immutably set a nested value, materializing missing intermediate containers.
 * @param root - draft root (never mutated).
 * @param path - non-empty key path.
 * @param value - value to store at the path.
 * @returns the new draft root.
 */
export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) throw new Error('schema-form: setPath needs a non-empty path')
  const result = { ...root }
  let target: Record<string, unknown> | unknown[] = result
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string
    const child = cloneContainer(
      Array.isArray(target) ? target[Number(key)] : (target)[key],
      path[i + 1] as string,
    )
    if (Array.isArray(target)) target[Number(key)] = child
    else (target)[key] = child
    target = child
  }
  const leaf = path[path.length - 1] as string
  if (Array.isArray(target)) target[Number(leaf)] = value
  else (target)[leaf] = value
  return result
}

/**
 * Immutably remove a nested key (the per-field reset: the resolved value
 * falls back to the composition base and schema defaults). Removing along a
 * missing branch returns the root unchanged.
 * @param root - draft root (never mutated).
 * @param path - non-empty key path.
 * @returns the new draft root.
 */
export function deletePath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  if (path.length === 0) throw new Error('schema-form: deletePath needs a non-empty path')
  if (!hasPath(root, path)) return root
  const result = { ...root }
  let target: Record<string, unknown> | unknown[] = result
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string
    const child = cloneContainer(
      Array.isArray(target) ? target[Number(key)] : (target)[key],
      path[i + 1] as string,
    )
    if (Array.isArray(target)) target[Number(key)] = child
    else (target)[key] = child
    target = child
  }
  const leaf = path[path.length - 1] as string
  if (Array.isArray(target)) target.splice(Number(leaf), 1)
  else Reflect.deleteProperty(target, leaf)
  return result
}
