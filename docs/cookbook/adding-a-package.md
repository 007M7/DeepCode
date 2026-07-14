# Cookbook: adding a workspace package

The file-by-file checklist for a new `@deepseek-ai/dsh-<name>` package. (Verified by the bash and adapter packages; if it drifts, fix it here.)

## 1. Create the package

```
packages/<group>/<pkg>/
  package.json     # copy from packages/core/tools, adjust name/description/deps
  tsconfig.json    # extends ../../../tsconfig.base.json, rootDir src,
                   # outDir lib/types, references: ../../../vendor/cosmokit,
                   # ../../../vendor/cordis (+ ../../../vendor/schemastery if
                   # you use Config, + ../../<group>/<dep> for each dsh dep)
  src/index.ts     # service default export or plugin (name/inject/apply/Config)
  tests/<x>.spec.ts
  README.md        # service API, events, extension points, design notes,
                   # + gated Model Experience context blocks or short sentence
                   # + the gated "Known Limitations and Deferred Work" section
                   # (or a whitelist entry in scripts/verify-package-readme-limitations.ts)
```

Choose an existing group when one matches the package's role (`core`, `llm`, `bash`, `compact`, `subagent`, `todo`, `session-persistence`, `ui`, `util`, or `support`). A new group is allowed, but it is a pure container: no `package.json`, no source files, and packages still sit exactly one level below it.

package.json invariants (enforced by `pnpm run constraints` / `scripts/check-workspace-constraints.ts`): `private: true`, a `version` matching the root `package.json`, `type: module`, `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, `exports["."].types: "./lib/types/index.d.ts"`, `exports["."].default: "./lib/index.js"`, `cordis` in BOTH peerDependencies and devDependencies (same range). Mirror every dsh peer dependency in devDependencies. `schemastery` goes in `dependencies` (it is a runtime validator), matching agent-loop. The `files` list is precise: `lib/index.js`, `lib/types/**/*.d.ts`, `lib/types/**/*.d.ts.map`, and `src`; do not publish `lib/types` JS or JS-map intermediates or stale root declaration files. CLI app packages with a package `bin` include `lib/bin.js` immediately after `lib/index.js` in `files`.

In-package relative imports use explicit `.ts` specifiers in source (for example, `export * from './types.ts'`). The compiler rewrites those to `.js` in emitted JS and leaves explicit `.ts` specifiers in declarations, which standard NodeNext/Node16 TypeScript consumers resolve to the sibling `.d.ts` files.

## 2. Register it in the root configs

| File | Change |
|---|---|
| `tsconfig.base.json` | no edit for an existing group; for a new group, add a `./packages/<group>/*/src` candidate to the `@deepseek-ai/dsh-*` wildcard |
| `tsconfig.json` | add `{ "path": "./packages/<group>/<pkg>" }` to `references` |
| `tsconfig.build.json` | add `{ "path": "./packages/<group>/<pkg>" }` to `references` |
| `knip.json` | only if the package has non-`*.spec.ts` entries (e.g. `*.e2e.ts` → add a per-workspace override like `packages/llm/llm-deepseek`) |

Covered automatically by globs or package-manifest discovery — no edits needed: root `package.json` workspaces, `scripts/publint-all.ts`, `tsdown.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `scripts/check-workspace-constraints.ts`.

## 3. Decide the package topology

For a swappable capability, split interface / implementation / consumer into separate packages (see docs/architecture.md § "Capability seams" — the bash trio is the template). A single-purpose plugin stays one package.

## 4. Write the package README

Keep package-specific service API, config, events, extension points, and design notes first. Document only behavior, limitations, and deferred work owned by this package: a feature already implemented elsewhere is not this package's limitation. An indirect Model Experience sentence may name the consumer that surfaces this package's contribution, but it does not restate that consumer's implementation. End a package README with this canonical sequence:

````markdown
## Model Experience

### Request surface and condition

**What the model sees**: An exact data-dependent shape, an anchored generated-catalog link, or an introduction to the verbatim literal below.

**Token effect**: Fixed, conditional, retained, replaced, capped, or zero-direct token effect.

#### Verbatim text for this context surface, when needed

```markdown
Stable system-prompt prose of any length, or another long non-generated literal, copied exactly from source.
```

## Known Limitations and Deferred Work

- **Consumer-visible gap** — exact boundary or deliberately deferred work.
````

Fill Model Experience from the implementation. Direct, multi-surface, conditional, capped, or lifetime effects use one H3 block per context surface; each block has the exact bold-led `What the model sees` and `Token effect` fields shown above. A structured section grounds at least one surface in concrete model-visible text through inline code, a nested `markdown` block, or an anchored tool-catalog link. Put every stable system-prompt paragraph, including a one-liner, in a titled H4 plus `markdown` fence immediately after those fields inside the owning H3 whose title contains `system prompt`; never leave prompt prose in inline code. Quote other short stable model-visible source literals inline, using named placeholders such as `<mode>` only for interpolated values, and attach other long non-generated literals to their owning H3 in the same H4-plus-fence form. Describe an attached literal as the text "below" instead of linking between Model Experience subsections; the physical nesting already records ownership. A tool-schema surface uses `schema` in its H3 and links the relevant anchored package section in the generated [tool schema catalog](../tool-catalog.md) instead of copying its default descriptions or JSON Schema; describe only configuration or composition deltas the catalog does not contain. A runtime-only definition outside the catalog's stated scope links that scope and explains the exception before reproducing its stable text. Summarize data-dependent payloads or provider-owned text by identifying their exact shape and renderer. Do not infer prompt visibility from tool-schema visibility because independently registered guidance can remain after a scoped tool restriction.

An audited package with no context effect or one simple consumer-owned path belongs in [`SENTENCE_MODEL_EXPERIENCE`](../../scripts/verify-package-readme-model-experience.ts) and uses one line beginning `None, as ` or `Indirectly, through `. A generic package whose public contract is model-agnostic may instead join the narrow `NO_MODEL_EXPERIENCE_SECTION` allowlist and omit the heading entirely; the allowlist retains the audit reason so absence cannot mean forgotten documentation. Pure transport and keyless test-support packages otherwise use `None, as ` when they create no model-bound content even if consumers use them during composition. A provider backend whose single context path is formatted and inserted entirely by a named consumer uses `Indirectly, through ` even when it caps or filters data before returning it; so does a wiring bundle whose model effects all belong to named children. Do not give these packages a structured block describing another package's work. Packages that own model input, output shaping, multiple context paths, or an auxiliary request keep context-surface blocks; the verifier gates their H3 headings, field labels, spacing, concrete literal evidence, nested H4-plus-`markdown` blocks, absence of local subsection links, system-prompt literals, and schema-surface-to-catalog links. A package with genuinely no limitations joins the separate allowlist in [`verify-package-readme-limitations.ts`](../../scripts/verify-package-readme-limitations.ts); the two omission allowlists are independent. The [Model Experience RFC](../rfc/implemented/process/2026-07-12-package-model-experience-contract.md) records the rationale.

## 5. Verify

```sh
pnpm install        # registers the workspace
pnpm run doc-sync
pnpm run constraints && pnpm run typecheck && pnpm run lint
pnpm run test:coverage  # 100% per-file over src (types.ts exempt)
pnpm run build && pnpm run hygiene
```

Test expectations: every registry/registration needs an HMR-safety test (register from a child fiber, dispose it, assert cleanup). Excessive tests are welcome — see [docs/testing.md](../testing.md).
