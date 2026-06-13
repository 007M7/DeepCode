# Cookbook: adding a workspace package

The file-by-file checklist for a new `@deepseek-ai/dsh-<name>` package. (Verified by the bash and adapter packages; if it drifts, fix it here.)

## 1. Create the package

```
packages/<name>/
  package.json     # copy from packages/tools, adjust name/description/deps
  tsconfig.json    # extends ../../tsconfig.base.json, rootDir src, outDir lib,
                   # references: vendor/cosmokit, vendor/cordis (+ vendor/schemastery
                   # if you use Config, + ../<dep> for each dsh dependency)
  src/index.ts     # service default export or plugin (name/inject/apply/Config)
  tests/<x>.spec.ts
  README.md        # service API, events, extension points, design notes
```

package.json invariants (enforced by `yarn constraints` / yarn.config.cjs): `private: true`, `version: 0.0.1`, `type: module`, `cordis` in BOTH peerDependencies and devDependencies (same range). Mirror every dsh peer dependency in devDependencies. `schemastery` goes in `dependencies` (it is a runtime validator), matching agent-loop.

## 2. Register it in the root configs

| File | Change |
|---|---|
| `tsconfig.base.json` | add `"@deepseek-ai/dsh-<name>": ["./packages/<name>/src"]` to `paths` |
| `tsconfig.typecheck.json` | same entry (this file overrides the map wholesale) |
| `tsconfig.build.json` | add `{ "path": "./packages/<name>" }` to `references` |
| `scripts/publint-all.ts` | add `'packages/<name>'` to the array |
| `knip.json` | only if the package has non-`*.spec.ts` entries (e.g. `*.e2e.ts` → add a per-workspace override like `packages/llm-deepseek`) |

Covered automatically by globs — no edits needed: root `package.json` workspaces, `tsdown.config.ts`, `vitest.config.ts`, `eslint.config.mjs`.

## 3. Decide the package topology

For a swappable capability, split interface / implementation / consumer into separate packages (see docs/architecture.md § "Capability seams" — the bash trio is the template). A single-purpose plugin stays one package.

## 4. Verify

```sh
yarn install        # registers the workspace
yarn constraints && yarn typecheck && yarn lint
yarn test:coverage  # 100% per-file over src (types.ts exempt)
yarn build && yarn knip && yarn publint
```

Test expectations: every registry/registration needs an HMR-safety test (register from a child fiber, dispose it, assert cleanup). Excessive tests are welcome — see AGENTS.md.
