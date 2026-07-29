/**
 * Schema-driven React form renderer for settings sections. `SchemaForm`
 * rehydrates the wire's serialized schemastery envelope and edits a draft
 * user section against it; the model helpers expose the same introspection
 * and immutable path editing for page-level composition.
 * @module @deepseek-ai/dsh-client-schema-form
 */

export { SchemaForm } from './SchemaForm.tsx'
export type {
  SchemaFieldContext, SchemaFormLabels, SchemaFormProps, SchemaFormSecret,
} from './SchemaForm.tsx'
export {
  deletePath, getPath, hasPath, nodeAtPath, nodeKind, rehydrateSchema, setPath, unionChoices, validateDraft,
} from './model.ts'
export type { NodeKind, SchemaNode } from './model.ts'
