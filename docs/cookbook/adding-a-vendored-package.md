# Cookbook: adding a vendored package

When the harness needs another upstream Cordis package (e.g. `@cordisjs/plugin-http`), it is **vendored** as pinned source under `vendor/`, not added as an npm dependency — see [the vendoring decision](../rfc/implemented/process/2026-06-11-vendor-cordis-as-source.md) for why. [vendor/README.md](../../vendor/README.md) covers *updating* an already-vendored package; this guide is the file-by-file checklist for adding a **new** one. (Verified against the existing vendored set; if it drifts, fix it here.)

## 1. Copy the source in

```
vendor/<dir>/
  package.json     # from upstream; set "private": true, keep name/exports/type
  tsconfig.json    # extends ../../tsconfig.base.json (see shape below)
  src/             # the upstream src/ verbatim
  README.md LICENSE # if upstream ships them
```

`tsconfig.json` mirrors the other vendored packages — `rootDir: src`, `outDir: lib`, the strictness relaxations upstream code needs, and a `references` entry for every other vendored package it imports:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src", "outDir": "lib",
    "noUncheckedIndexedAccess": false, "exactOptionalPropertyTypes": false,
    "noImplicitOverride": false, "noUnusedLocals": false, "noUnusedParameters": false
  },
  "include": ["src"],
  "references": [{ "path": "../cordis" }, { "path": "../cosmokit" }]
}
```

`package.json` invariants: `"private": true` (vendored packages are never published), keep upstream's `name`/`version`/`exports`/`type`, and list its cordis deps in `peerDependencies` (matching the upstream manifest). Transitive upstream deps must themselves be vendored or already present — vendoring one package often means vendoring its dependency tree (e.g. `@cordisjs/plugin-http` pulls `@cordisjs/fetch-file`).

## 2. Register it in the root configs

| File | Change |
|---|---|
| `tsconfig.base.json` | add `"<npm-name>": ["./vendor/<dir>/src"]` to `paths` |
| `tsconfig.typecheck.json` | add `"<npm-name>": ["./vendor/<dir>/lib"]` — this file points at built declarations, not src. If the package's `types` entry isn't `lib/index.d.ts`, point at that built file instead (e.g. `logger-console` maps to `./vendor/logger-console/lib/shared`, matching its `"types": "lib/shared.d.ts"`). |
| `tsconfig.build.json` | add `{ "path": "./vendor/<dir>" }` to `references` (before the `packages/*` entries) |
| `vendor/README.md` | add a manifest table row (dir, npm name, version, upstream repo, commit SHA) and log any local modifications |
| `scripts/publint-all.ts` | only if the vendored package is itself published from here (vendored deps normally are not — skip) |

Covered automatically by globs — no edits needed: root `package.json` workspaces (`vendor/*`), `tsdown.config.ts`, `vitest.config.ts`, `eslint.config.mjs`. A per-package `vendor/<dir>/tsdown.config.ts` is needed ONLY if the build shape diverges from the root default (dual ESM/CJS or multiple entries — see `vendor/schemastery` and `vendor/logger-console`).

## 3. Mind the manifest guard

`scripts/check-vendor-manifest.sh` (a pre-commit hook) fails if anything under `vendor/*/src` is staged without `vendor/README.md` also staged. Stage the manifest update alongside the source so the commit passes.

## 4. Verify

```sh
pnpm install        # registers the workspace
pnpm run typecheck  # the base→lib path split means: run once after a fresh add
pnpm run build && pnpm run test && pnpm run constraints
```

Note the `tsconfig` two-map split (called out in [AGENTS.md](../../AGENTS.md) § Secrets/.env): `lint`'s type-aware rules resolve vendored packages through their built `lib/` declarations, so run `pnpm run typecheck` (which builds them) once after adding the package or lint reports unresolved-type errors.
