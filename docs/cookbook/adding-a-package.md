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
  README.md        # service API, events, extension points, design notes
```

Choose an existing group when one matches the package's role (`core`, `llm`, `bash`, `compact`, `subagent`, `todo`, `session-persistence`, `ui`, `util`, or `support`). A new group is allowed, but it is a pure container: no `package.json`, no source files, and packages still sit exactly one level below it.

package.json invariants (enforced by `pnpm run constraints` / `scripts/check-workspace-constraints.ts`): `private: true`, `version: 0.0.1`, `type: module`, `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, `exports["."].types: "./lib/types/index.d.ts"`, `exports["."].default: "./lib/index.js"`, `cordis` in BOTH peerDependencies and devDependencies (same range). Mirror every dsh peer dependency in devDependencies. `schemastery` goes in `dependencies` (it is a runtime validator), matching agent-loop. The `files` list is precise: `lib/index.js`, `lib/types/**/*.d.ts`, `lib/types/**/*.d.ts.map`, and `src`; do not publish `lib/types` JS or JS-map intermediates or stale root declaration files. CLI app packages with a package `bin` include `lib/bin.js` immediately after `lib/index.js` in `files`.

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

## 4. Verify

```sh
pnpm install        # registers the workspace
pnpm run constraints && pnpm run typecheck && pnpm run lint
pnpm run test:coverage  # 100% per-file over src (types.ts exempt)
pnpm run build && pnpm run hygiene
```

Test expectations: every registry/registration needs an HMR-safety test (register from a child fiber, dispose it, assert cleanup). Excessive tests are welcome — see AGENTS.md.
