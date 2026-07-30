# @deepseek-ai/dsh-typert-generator

English | [中文](README.zh.md)

TypeScript project analyzer and model-driven Typert generator. It converts the developer-authored source type tree into compiler-independent `FaceModel` and `TypeGraph` data before any artifact is rendered. Static analysis can consume that model without Cordis; emitters never receive TypeScript AST or checker objects.

Host and client use independent `ts.Program` instances seeded from `tsconfig.host.json` and `tsconfig.client.json`. Direct project references establish face membership, `package.json#exports` establishes every cross-package public boundary, and source imports or re-exports are the only allowed cross-face edges. Types owned by NPM dependencies, including global declarations from `@types` packages, remain `external` references instead of being expanded.

## Analysis Model

Each face contains package exports, Cordis services and events, explicitly tagged objects and schemas, and a type graph for their reachable declarations. The graph preserves declaration identity, generic parameters and applications, explicit inheritance, conditional and mapped types, import attributes, abstract modifiers, and source JSDoc. Service and `@typert object` surfaces expose public instance members only; constructors, static members, and non-public members are excluded.

`WorkspaceAnalyzer` defaults to `check` mode and fails on TypeScript syntax or semantic diagnostics, missing reachable public annotations, private cross-package references, and reachable declaration merges that the model cannot retain losslessly. `write` mode inserts checker-derived annotations, rebuilds the program, and returns a clean check-mode model.

## Emission and Opt-in Publication

`FaceModelEmitter` consumes only the model. It emits executable JavaScript containing supported Zod schemas and a `TYPERT` contribution, plus a declaration file whose schemas are typed as `z.ZodType<SourceType>` through the package's public export. Unsupported Zod projections fail instead of flattening or weakening the source type.

`WorkspaceTypertGenerator` discovers contributors by walking package public exports reachable from Cordis `Context` or `Events` augmentations and explicit `@typert` declarations. When invoked for artifact publication, it requires host artifacts at `lib/typert.host.{js,d.ts}` exposed as `package/typert`, and client artifacts at `lib/typert.client.{js,d.ts}` exposed as `package/client/typert`. Generated declarations expose `TYPERT` as `unknown`, so contributing business packages do not depend on the runtime registry.

Publication is package opt-in. The root build and typecheck do not generate Typert artifacts or require every business package to add Typert exports. Static consumers can call `WorkspaceAnalyzer` directly, select host/client and package subsets, and use bounded package batches without publishing or loading runtime artifacts.

## Repository-specific Cordis projection

The root package export includes the model-driven extraction, completeness checks, and deterministic text renderers used by this repository's Cordis catalogs. They accept a `CordisCatalogPolicy`; repository-owned type links, foundation/exemption classifications, and inherited Cordis entries remain in `scripts/gen-cordis-catalog.ts` and are passed in explicitly. The generator package therefore contains projection mechanics, not a hidden copy of this repository's documentation taxonomy.

## Model Experience

None, as this package runs at build or test time and never contributes to a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Package export patterns are skipped; contributing packages need concrete export targets.
- Cross-face named and star re-exports produce links; namespace re-exports fail until `TypeTargetModel` can represent a module namespace without flattening it.
- The Zod emitter supports a deliberate subset of the modeled TypeScript graph. Generic schema declarations and computed constructs such as conditional or mapped schema roots fail until a concrete schema-factory policy exists.
- Cross-face links are represented for analysis, but no generated schema currently requires a runtime cross-face Zod import.
- Discovery follows source files reachable from concrete public exports; declarations that are neither exported nor imported by that graph are intentionally outside the package model.
