/**
 * Reject JavaScript expressions in Cordis Loader entry metadata.
 *
 * The Loader interpolates only a plugin entry's `config`; expression objects in
 * fields such as `disabled` remain truthy data and silently change composition.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

interface JsExpr {
  __jsExpr: string
}

const root = resolve(import.meta.dirname, '..')
const metadataFields = ['id', 'name', 'group', 'disabled', 'inject', 'intercept', 'isolate'] as const
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

const files = globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
  cwd: root,
  exclude: ['.claude/**', 'node_modules/**', 'vendor/**'],
}).sort()
const errors: string[] = []

for (const file of files) {
  const document: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema })
  if (!isUnknownArray(document)) {
    errors.push(`${file}: root must be a Loader entry array`)
    continue
  }
  for (let index = 0; index < document.length; index++) {
    validateEntry(document[index], file, `[${index}]`)
  }
}

if (errors.length > 0) {
  console.error('verify-cordis-config: Loader entry metadata is static; move !!js under plugin config or select an explicit overlay.')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`verify-cordis-config: ${files.length} config files passed.`)
}

function validateEntry(value: unknown, file: string, path: string): void {
  if (!isRecord(value)) {
    errors.push(`${file}${path}: entry must be an object`)
    return
  }
  validateMetadata(value, file, path)
  if ((value.group === true || value.name === '@cordisjs/plugin-group') && isUnknownArray(value.config)) {
    for (let index = 0; index < value.config.length; index++) {
      validateEntry(value.config[index], file, `${path}.config[${index}]`)
    }
  }
  if (value.name !== '@cordisjs/plugin-include') return
  const config = value.config
  if (!isRecord(config) || !isUnknownArray(config.patches)) return
  for (let index = 0; index < config.patches.length; index++) {
    const patch = config.patches[index]
    const patchPath = `${path}.config.patches[${index}]`
    if (!isRecord(patch)) continue
    validateMetadata(patch, file, patchPath)
    if (!isUnknownArray(patch.insert)) continue
    for (let insertIndex = 0; insertIndex < patch.insert.length; insertIndex++) {
      validateEntry(patch.insert[insertIndex], file, `${patchPath}.insert[${insertIndex}]`)
    }
  }
}

function validateMetadata(entry: Record<string, unknown>, file: string, path: string): void {
  for (const field of metadataFields) {
    if (!(field in entry)) continue
    const expressionPaths: string[] = []
    collectExpressionPaths(entry[field], `${path}.${field}`, expressionPaths)
    for (const expressionPath of expressionPaths) errors.push(`${file}${expressionPath}: !!js is not interpolated here`)
  }
}

function collectExpressionPaths(value: unknown, path: string, output: string[]): void {
  if (isJsExpr(value)) {
    output.push(path)
    return
  }
  if (isUnknownArray(value)) {
    for (let index = 0; index < value.length; index++) collectExpressionPaths(value[index], `${path}[${index}]`, output)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) collectExpressionPaths(child, `${path}.${key}`, output)
}

function isJsExpr(value: unknown): value is JsExpr {
  return isRecord(value) && typeof value.__jsExpr === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}
