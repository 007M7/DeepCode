/**
 * Runtime registry for generated Typert contributions. It owns live Zod
 * instances and generated package reflection, but performs no TypeScript
 * analysis or schema generation.
 * @module @deepseek-ai/dsh-typert-registry
 */

import { Context, Service } from 'cordis'
import { z } from 'zod'
import type {
  TypertContribution,
  TypertFace,
  TypertPackageFilter,
  TypertPackageRecord,
  TypertSchemaFilter,
  TypertSchemaRecord,
} from './types.ts'

export type {
  TypertContribution,
  TypertDocTag,
  TypertDocumentation,
  TypertEventModel,
  TypertFace,
  TypertMemberModel,
  TypertObjectModel,
  TypertPackageFilter,
  TypertPackageModel,
  TypertPackageRecord,
  TypertSchema,
  TypertSchemaFilter,
  TypertSchemaRecord,
  TypertServiceModel,
  TypertTypeModel,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    typert: TypertRegistry
  }
}

/**
 * Compose the global key of one generated schema.
 * @param packageName - contributing npm package.
 * @param name - schema export name.
 * @returns `<package>#<name>`.
 */
export function typertKey(packageName: string, name: string): string {
  return `${packageName}#${name}`
}

/**
 * Compose the identity of one package-face model.
 * @param packageName - contributing npm package.
 * @param face - independently compiled face.
 * @returns `<package>#<face>`.
 */
export function typertPackageKey(packageName: string, face: TypertFace): string {
  return `${packageName}#${face}`
}

/**
 * Registry of generated schemas and package reflection.
 * @typert service
 */
export class TypertRegistry extends Service {
  private readonly schemas = new Map<string, TypertSchemaRecord>()
  private readonly packages = new Map<string, TypertPackageRecord>()

  constructor(ctx: Context) {
    super(ctx, 'typert')
  }

  /**
   * Register one generated contribution atomically for the calling fiber.
   * Duplicate package-face identities or schema keys reject the whole batch.
   * @param contribution - generated schemas and package metadata.
   * @returns the exact effect disposer that removes this contribution.
   */
  register(contribution: TypertContribution): () => void {
    const packageRecord = this.validatePackage(contribution)
    const schemaRecords = this.validateSchemas(contribution)
    const { schemas, packages } = this
    const dispose = this.ctx.effect(function* () {
      packages.set(packageRecord.key, packageRecord)
      for (const record of schemaRecords) schemas.set(record.key, record)
      yield () => {
        packages.delete(packageRecord.key)
        for (const record of schemaRecords) schemas.delete(record.key)
      }
    }, 'typert.register()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve Cordis disposer identity
    return dispose
  }

  /**
   * Look up one schema by `<package>#<name>`.
   * @param key - global schema key.
   * @returns the live schema record, or `undefined` when absent.
   */
  get(key: string): TypertSchemaRecord | undefined {
    return this.schemas.get(key)
  }

  /**
   * Resolve one required schema.
   * @param key - global schema key.
   * @returns the live schema record.
   * @throws when the key is malformed, the package face is absent, or the schema is not contributed.
   */
  resolve(key: string): TypertSchemaRecord {
    const record = this.schemas.get(key)
    if (record !== undefined) return record
    const hash = key.indexOf('#')
    if (hash <= 0 || hash === key.length - 1) {
      throw new Error(`typert: invalid schema key "${key}" — expected "<package>#<name>"`)
    }
    const packageName = key.slice(0, hash)
    if ([...this.packages.values()].some(candidate => candidate.package === packageName)) {
      throw new Error(
        `typert: cannot resolve "${key}" — package "${packageName}" is registered but contributes no schema named "${key.slice(hash + 1)}"`,
      )
    }
    throw new Error(`typert: cannot resolve "${key}" — package "${packageName}" has no registered contribution`)
  }

  /**
   * Enumerate live schemas in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching schema records.
   */
  list(filter: TypertSchemaFilter = {}): TypertSchemaRecord[] {
    return [...this.schemas.values()].filter(record => matches(record, filter))
  }

  /**
   * Look up generated reflection for one package face.
   * @param packageName - exact npm package name.
   * @param face - face to query; defaults to the host runtime.
   * @returns the live package record, or `undefined` when absent.
   */
  getPackage(packageName: string, face: TypertFace = 'host'): TypertPackageRecord | undefined {
    return this.packages.get(typertPackageKey(packageName, face))
  }

  /**
   * Enumerate generated package reflection in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching package records.
   */
  listPackages(filter: TypertPackageFilter = {}): TypertPackageRecord[] {
    return [...this.packages.values()].filter(record => matches(record, filter))
  }

  /**
   * Project a live Zod schema to JSON Schema without caching the result.
   * @param key - global schema key.
   * @param params - Zod projection parameters.
   * @returns a fresh JSON Schema document.
   */
  toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams): z.core.JSONSchema.BaseSchema {
    return z.toJSONSchema(this.resolve(key).schema, params)
  }

  private validatePackage(contribution: TypertContribution): TypertPackageRecord {
    validateSegment('package name', contribution.package)
    const face: unknown = contribution.face
    if (face !== 'host' && face !== 'client') {
      throw new Error(`typert: invalid face ${JSON.stringify(face)} — expected "host" or "client"`)
    }
    const key = typertPackageKey(contribution.package, contribution.face)
    if (this.packages.has(key)) {
      throw new Error(`typert: package face "${key}" is already registered`)
    }
    return {
      package: contribution.package,
      face,
      key,
      model: contribution.model,
    }
  }

  private validateSchemas(contribution: TypertContribution): TypertSchemaRecord[] {
    const records: TypertSchemaRecord[] = []
    const batch = new Set<string>()
    for (const schema of contribution.schemas) {
      validateSegment('schema name', schema.name)
      const key = typertKey(contribution.package, schema.name)
      if (batch.has(key) || this.schemas.has(key)) {
        throw new Error(`typert: schema "${key}" is already registered`)
      }
      batch.add(key)
      records.push({
        ...schema,
        package: contribution.package,
        face: contribution.face,
        key,
      })
    }
    return records
  }
}

function matches(
  record: { readonly package: string; readonly face: TypertFace },
  filter: { readonly package?: string; readonly face?: TypertFace },
): boolean {
  return (filter.package === undefined || record.package === filter.package)
    && (filter.face === undefined || record.face === filter.face)
}

function validateSegment(subject: string, value: string): void {
  if (value.length === 0 || value.includes('#')) {
    throw new Error(`typert: invalid ${subject} "${value}" — must be nonempty and must not contain "#"`)
  }
}

export default TypertRegistry
