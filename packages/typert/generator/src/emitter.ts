/**
 * Model-driven Typert artifact emitter. It consumes only FaceModel and
 * TypeGraph data; TypeScript compiler nodes are not part of this boundary.
 * @module @deepseek-ai/dsh-typert-generator/emitter
 */

import type {
  DocumentationModel,
  FaceModel,
  MemberModel,
  PackageModel,
  SchemaModel,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
} from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'

/** Failure to project a modeled construct into an emitted artifact. */
export class TypertEmitError extends Error {
  override name = 'TypertEmitError'
}

/** JavaScript and declaration artifacts for one package on one face. */
export interface ModelEmitResult {
  readonly package: string
  readonly face: FaceModel['face']
  readonly exports: readonly string[]
  readonly js: string
  readonly dts: string
}

interface RuntimeMemberModel {
  readonly kind: MemberModel['kind']
  readonly name: string
  readonly signature: string
  readonly summary?: string
  readonly jsDoc?: string
}

interface RuntimeTypeModel {
  readonly name: string
  readonly declaration: string
}

interface RuntimeServiceModel extends DocumentationModel {
  readonly key: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimeEventModel extends DocumentationModel {
  readonly name: string
  readonly mode?: string
  readonly signature: string
}

interface RuntimeObjectModel extends DocumentationModel {
  readonly name: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimePackageModel {
  readonly services: readonly RuntimeServiceModel[]
  readonly events: readonly RuntimeEventModel[]
  readonly objects: readonly RuntimeObjectModel[]
}

/** Emit generated runtime and type artifacts from one independently analyzed face. */
export class FaceModelEmitter {
  private readonly renderer: TypeGraphRenderer

  /**
   * Create an emitter for one face graph.
   * @param face - independently analyzed face.
   */
  constructor(private readonly face: FaceModel) {
    this.renderer = new TypeGraphRenderer(face.graph)
  }

  /**
   * Emit one modeled package.
   * @param packageName - exact package name in the face model.
   * @returns executable JavaScript and its precise declaration file.
   */
  emit(packageName: string): ModelEmitResult {
    const packageModel = this.face.packages.find(candidate => candidate.name === packageName)
    if (packageModel === undefined) {
      throw new TypertEmitError(`typert emitter(${this.face.face}): package ${packageName} is not modeled on this face`)
    }
    const schemas = new SchemaEmitter(this.renderer, packageModel.schemas)
    const schemaArtifact = schemas.emit()
    const runtimeModel = this.runtimeModel(packageModel)
    const js = this.renderJs(packageModel, schemaArtifact, runtimeModel)
    const dts = this.renderDts(packageModel, schemaArtifact)
    return {
      package: packageName,
      face: this.face.face,
      exports: packageModel.schemas.map(schema => schema.export.name),
      js,
      dts,
    }
  }

  private runtimeModel(packageModel: PackageModel): RuntimePackageModel {
    const services = packageModel.services.map((service): RuntimeServiceModel => {
      const members = service.members.map(id => this.runtimeMember(this.renderer.member(id)))
      return {
        ...documentationLiteral(service),
        key: service.key,
        exportName: service.export.name,
        members,
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(service.members), service.symbol),
      }
    })
    const events = packageModel.events.map((event): RuntimeEventModel => {
      const node = this.renderer.node(event.signature)
      if (node.kind !== 'function') {
        throw new TypertEmitError(`typert emitter(${this.face.face}): event ${event.name} is not a function type`)
      }
      return {
        ...documentationLiteral(event),
        name: event.name,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        signature: `${quote(event.name)}${this.renderer.renderSignature(node.signature)}`,
      }
    })
    const objects = packageModel.objects.map((object): RuntimeObjectModel => {
      const declaration = this.renderer.declaration(object.symbol)
      return {
        ...documentationLiteral(object),
        name: declaration.name,
        exportName: object.export.name,
        members: declaration.members.map(member => this.runtimeMember(member)),
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(declaration.members.map(member => member.id)), declaration.id),
      }
    })
    return { services, events, objects }
  }

  private runtimeMember(member: MemberModel): RuntimeMemberModel {
    return {
      kind: member.kind,
      name: member.name,
      signature: this.renderer.renderMember(member, true),
      ...(member.summary === undefined ? {} : { summary: member.summary }),
      ...(member.jsDoc === undefined ? {} : { jsDoc: member.jsDoc }),
    }
  }

  private runtimeTypes(declarations: readonly TypeDeclarationModel[], root: SymbolId): RuntimeTypeModel[] {
    return declarations
      .filter(declaration => declaration.id !== root)
      .map(declaration => ({
        name: declaration.name,
        declaration: this.renderer.renderDeclaration(declaration.id),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private renderJs(
    packageModel: PackageModel,
    schemas: SchemaArtifact,
    runtimeModel: RuntimePackageModel,
  ): string {
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    if (schemas.definitions.length > 0) lines.push('import { z } from \'zod\'', '')
    lines.push(...schemas.definitions)
    if (schemas.definitions.length > 0) lines.push('')
    for (const schema of schemas.exports) lines.push(`export const ${schema.exportName} = ${schema.internalName}`)
    if (schemas.exports.length > 0) lines.push('')
    const model = JSON.stringify(runtimeModel, null, 2)
    lines.push('export const TYPERT = {')
    lines.push(`  package: ${quote(packageModel.name)},`)
    lines.push(`  face: ${quote(this.face.face)},`)
    lines.push('  schemas: [')
    for (const schema of schemas.exports) {
      lines.push(`    { name: ${quote(schema.exportName)}, schema: ${schema.exportName} },`)
    }
    lines.push('  ],')
    lines.push(`  model: ${indent(model, 2).trimStart()},`)
    lines.push('}')
    return `${lines.join('\n')}\n`
  }

  private renderDts(packageModel: PackageModel, schemas: SchemaArtifact): string {
    const imports = new Map<string, string[]>()
    for (const schema of schemas.exports) {
      const specifier = packageExportSpecifier(packageModel.name, schema.model.export.subpath)
      const names = imports.get(specifier) ?? []
      names.push(`${schema.model.export.name} as ${schema.exportName}$source`)
      imports.set(specifier, names)
    }
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    if (schemas.exports.length > 0) lines.splice(1, 0, 'import type { z } from \'zod\'')
    for (const [specifier, names] of [...imports].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`import type { ${names.sort().join(', ')} } from ${quote(specifier)}`)
    }
    lines.push('')
    for (const schema of schemas.exports) {
      lines.push(`export declare const ${schema.exportName}: z.ZodType<${schema.exportName}$source>`)
    }
    if (schemas.exports.length > 0) lines.push('')
    // The Loader validates and narrows this generated module boundary before
    // registration. Keeping the public declaration unknown prevents every
    // contributing business package from depending on the runtime registry.
    lines.push('export declare const TYPERT: unknown')
    return `${lines.join('\n')}\n`
  }
}

interface SchemaExport {
  readonly model: SchemaModel
  readonly exportName: string
  readonly internalName: string
}

interface SchemaArtifact {
  readonly definitions: readonly string[]
  readonly exports: readonly SchemaExport[]
}

class SchemaEmitter {
  private readonly names = new Map<SymbolId, string>()
  private readonly declarations: TypeDeclarationModel[]

  constructor(
    private readonly renderer: TypeGraphRenderer,
    private readonly schemas: readonly SchemaModel[],
  ) {
    const declarations = new Map<SymbolId, TypeDeclarationModel>()
    for (const schema of schemas) {
      for (const declaration of renderer.declarationClosureForTypes([schema.type])) {
        declarations.set(declaration.id, declaration)
      }
    }
    this.declarations = renderer.graph.declarations.filter(declaration => declarations.has(declaration.id))
    const identifiers = new Set<string>()
    for (const declaration of this.declarations) {
      const base = `${safeIdentifier(declaration.name)}$schema`
      let name = base
      let suffix = 2
      while (identifiers.has(name)) name = `${base}${String(suffix++)}`
      identifiers.add(name)
      this.names.set(declaration.id, name)
    }
  }

  emit(): SchemaArtifact {
    const definitions = this.declarations.map((declaration) => {
      if (declaration.typeParameters.length > 0) {
        this.fail(declaration.name, 'generic declarations require a schema-factory projection')
      }
      return `const ${this.schemaName(declaration.id)} = ${this.declarationSchema(declaration)}`
    })
    const exports = this.schemas.map((model): SchemaExport => ({
      model,
      exportName: safeIdentifier(model.export.name),
      internalName: this.schemaName(model.symbol),
    }))
    return { definitions, exports }
  }

  private declarationSchema(declaration: TypeDeclarationModel): string {
    if (declaration.kind === 'enum') {
      this.fail(declaration.name, 'enum declarations have no Zod projection')
    }
    if (declaration.kind === 'alias') {
      if (declaration.type === undefined) this.fail(declaration.name, 'alias has no modeled type')
      return this.describe(this.typeSchema(declaration.type), declaration)
    }
    const own = this.objectSchema(declaration.members, declaration.name)
    let result = own
    for (const heritage of declaration.extends) {
      result = `z.intersection(${this.typeSchema(heritage)}, ${result})`
    }
    return this.describe(result, declaration)
  }

  private typeSchema(id: TypeNodeId): string {
    const node = this.renderer.node(id)
    switch (node.kind) {
      case 'keyword': return this.keywordSchema(node.name)
      case 'literal': return `z.literal(${node.text})`
      case 'parenthesized': return this.typeSchema(node.type)
      case 'reference': return this.referenceSchema(node)
      case 'union': {
        if (node.types.length === 0) return 'z.never()'
        if (node.types.length === 1) return this.typeSchema(node.types[0] as TypeNodeId)
        return `z.union([${node.types.map(type => this.typeSchema(type)).join(', ')}])`
      }
      case 'intersection': {
        const [head, ...tail] = node.types
        if (head === undefined) return 'z.unknown()'
        return tail.reduce((left, right) => `z.intersection(${left}, ${this.typeSchema(right)})`, this.typeSchema(head))
      }
      case 'array': return `z.array(${this.typeSchema(node.element)})`
      case 'tuple': {
        const fixed = node.elements.filter(element => !element.rest)
        const rest = node.elements.find(element => element.rest)
        let schema = `z.tuple([${fixed.map(element => this.optional(this.typeSchema(element.type), element.optional)).join(', ')}])`
        if (rest !== undefined) schema += `.rest(${this.tupleRestSchema(rest.type)})`
        return schema
      }
      case 'object': return this.objectSchema(node.members, id)
      case 'operator':
      case 'indexed-access':
      case 'conditional':
      case 'infer':
      case 'mapped':
      case 'template-literal':
      case 'type-query':
      case 'import-type':
      case 'predicate':
      case 'function':
      case 'constructor':
      case 'this': return this.unsupported(node)
    }
  }

  private referenceSchema(node: Extract<TypeNodeModel, { kind: 'reference' }>): string {
    if (node.target.kind === 'declaration') {
      return `z.lazy(() => ${this.schemaName(node.target.symbol)})`
    }
    if (node.target.kind === 'standard') {
      switch (node.target.name) {
        case 'Array':
        case 'ReadonlyArray': {
          const element = node.arguments[0]
          if (element === undefined) this.fail(node.name, 'array reference has no element type')
          return this.readonly(`z.array(${this.typeSchema(element)})`, node.target.name === 'ReadonlyArray')
        }
        case 'Record': {
          const key = node.arguments[0]
          const value = node.arguments[1]
          if (key === undefined || value === undefined) this.fail(node.name, 'Record requires key and value types')
          return `z.record(${this.typeSchema(key)}, ${this.typeSchema(value)})`
        }
        case 'Date': return 'z.date()'
        default: this.fail(node.name, `standard type ${node.target.name} has no Zod projection`)
      }
    }
    this.fail(node.name, `${node.target.kind} reference has no Zod projection`)
  }

  private tupleRestSchema(id: TypeNodeId): string {
    const node = this.renderer.node(id)
    if (node.kind === 'array') return this.typeSchema(node.element)
    if (node.kind === 'reference'
      && node.target.kind === 'standard'
      && (node.target.name === 'Array' || node.target.name === 'ReadonlyArray')) {
      const element = node.arguments[0]
      if (element === undefined) this.fail(node.name, 'tuple rest array has no element type')
      return this.typeSchema(element)
    }
    this.fail(id, 'tuple rest element must retain an array type')
  }

  private objectSchema(members: readonly MemberModel[], subject: string): string {
    const properties: string[] = []
    for (const member of members) {
      if (member.static || member.visibility !== 'public') continue
      if (member.kind !== 'property') this.fail(subject, `${member.kind} member ${member.name} is not data-schema projectable`)
      const property = this.describe(
        this.optional(this.readonly(this.typeSchema(member.type), member.readonly), member.optional),
        member,
      )
      properties.push(`${quote(member.name)}: ${property}`)
    }
    return `z.object({${properties.length === 0 ? '' : `\n${properties.map(property => `  ${property},`).join('\n')}\n`}})`
  }

  private keywordSchema(name: string): string {
    switch (name) {
      case 'any': return 'z.any()'
      case 'unknown': return 'z.unknown()'
      case 'never': return 'z.never()'
      case 'string': return 'z.string()'
      case 'number': return 'z.number()'
      case 'bigint': return 'z.bigint()'
      case 'boolean': return 'z.boolean()'
      case 'symbol': return 'z.symbol()'
      case 'undefined': return 'z.undefined()'
      case 'void': return 'z.void()'
      case 'object': return "z.custom((value) => (typeof value === 'object' && value !== null) || typeof value === 'function')"
      default: this.fail(name, `keyword ${name} has no Zod projection`)
    }
  }

  private schemaName(symbol: SymbolId): string {
    const name = this.names.get(symbol)
    if (name === undefined) this.fail(symbol, 'referenced declaration is outside the selected schema closure')
    return name
  }

  private describe(schema: string, documentation: DocumentationModel): string {
    return documentation.description === undefined ? schema : `${schema}.describe(${quote(documentation.description)})`
  }

  private optional(schema: string, optional: boolean): string {
    return optional ? `${schema}.optional()` : schema
  }

  private readonly(schema: string, readonly: boolean): string {
    return readonly ? `${schema}.readonly()` : schema
  }

  private unsupported(node: TypeNodeModel): never {
    this.fail(node.id, `type node ${node.kind} has no Zod projection`)
  }

  private fail(subject: string, message: string): never {
    throw new TypertEmitError(`typert Zod emitter: ${subject}: ${message}`)
  }
}

function documentationLiteral(documentation: DocumentationModel): DocumentationModel {
  return {
    ...(documentation.description === undefined ? {} : { description: documentation.description }),
    ...(documentation.summary === undefined ? {} : { summary: documentation.summary }),
    tags: documentation.tags,
    ...(documentation.jsDoc === undefined ? {} : { jsDoc: documentation.jsDoc }),
  }
}

function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}

function safeIdentifier(name: string): string {
  const normalized = name.replace(/[^$\w]/gu, '_')
  if (/^[$A-Z_a-z]/u.test(normalized)) return normalized
  return `_${normalized}`
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => `${prefix}${line}`).join('\n')
}
