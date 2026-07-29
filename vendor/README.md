# Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries. They are copied into this monorepo instead of being depended on via npm, so that the harness fully owns its framework layer (auditable, patchable, pinned).

All vendored packages keep their **original npm names** (they are resolved through pnpm workspaces) and are marked `private: true` — they are never published from this repo. Upstream MIT `LICENSE` files are preserved in each package directory.

This file covers the manifest, the local-modification log, and the procedure for **updating** an existing vendored package. To **add a new** one, see the cookbook guide: [docs/cookbook/adding-a-vendored-package.md](../docs/cookbook/adding-a-vendored-package.md).

## Manifest

Upstream workspace: `cordis-workspace` (local checkout: `~/repos/cordis-workspace`).

| Directory | npm name | Version | Upstream repo | Commit |
|---|---|---|---|---|
| `cosmokit/` | `cosmokit` | 1.8.1 | https://github.com/deepseek-harness/cosmokit | `16f6fc058ade66e8ac5da0033d35a8d0f279f544` |
| `schemastery/` | `schemastery` | 3.18.0 | https://github.com/deepseek-harness/schemastery (`packages/core`) | `e67cee00ad725bd1534aee930a979ea3eec6f698` |
| `cordis/` | `cordis` | 4.0.0-rc.7 | https://github.com/cordiverse/cordis (`packages/core`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `loader/` | `@cordisjs/plugin-loader` | 1.0.0-rc.5 | https://github.com/cordiverse/cordis (`packages/loader`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `include/` | `@cordisjs/plugin-include` | 1.0.4 | https://github.com/deepseek-harness/cordis (`packages/include`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `group/` | `@cordisjs/plugin-group` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/group`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `timer/` | `@cordisjs/plugin-timer` | 1.1.2 | https://github.com/deepseek-harness/cordis (`packages/timer`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `hmr/` | `@cordisjs/plugin-hmr` | 1.0.15 | https://github.com/deepseek-harness/cordis (`packages/hmr`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `logger-console/` | `@cordisjs/plugin-logger-console` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/logger-console`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |

Third-party dependencies of the vendored packages stay on npm: `@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`, `supports-color`, `node-addon-require-builtin`.

Intentionally **not** vendored (verified unused by this set): `reggol`, `@cordisjs/utils`, `@cordisjs/element`, `@cordisjs/unyaml` (dev-time YAML import hook only).

## Local modifications

Keep this log exhaustive — every divergence from upstream must be listed.

1. **`hmr/src/index.ts`**: removed the `./locales/en-US.yml` / `./locales/zh-CN.yml` imports, the `.i18n({...})` call on the `Config` schema, and the `src/locales/` directory. Rationale: those imports require a runtime YAML loader hook (`@cordisjs/unyaml`) that we do not vendor; the i18n texts only localize config descriptions.
2. **All `package.json` files**: regenerated — added `private: true`, added precise `files` entries for bundled runtime files and `lib/types/**/*.d.ts` / `.d.ts.map`, preserved `src` in `files` only for packages whose previous file list already shipped it, added a `./src/*` export where missing, pointed declaration metadata at `lib/types`, and removed upstream `devDependencies`/`scripts`/`repository` fields. Dependency and peer-dependency ranges preserved, except `hmr` declares `esbuild` as a direct dev dependency because its source imports the `BuildFailure` type and pnpm's strict workspace resolution requires the owner package to name that dependency.
3. **All `tsconfig.json` files**: regenerated to extend the repo-root `tsconfig.base.json`, emit TypeScript intermediates to `lib/types`, and declare project references.
4. **Vendored TypeScript source internal specifiers**: changed local relative imports/exports from upstream's specifier shape to explicit `.ts` specifiers so TypeScript rewrites emitted JS to `.js` while declarations keep explicit, NodeNext-safe `.ts` specifiers. This includes `loader/src/config/isolate.ts` using `declare module './entry.ts'`.
5. **`schemastery/tsdown.config.ts` and `logger-console/tsdown.config.ts`**: ours, not upstream files — per-package build-shape overrides (dual ESM+CJS output; separate node/browser entries) for the repo-root tsdown build. They read the JS emitted under `lib/types` and then write the publish runtime entries under `lib/`. Like the regenerated tsconfigs, they are not part of the upstream sync surface.
6. **`cordis/src/fiber.ts` lifecycle hardening**: locally closes three reentrant disposal gaps. An effect's owner-list wrapper is registered before its setup body runs, so an unload begun from inside setup awaits setup and every collected cleanup; synchronous setup failure removes the wrapper and rolls back collected cleanup. Async cleanup stays owner-visible until quiescence, and Cordis's internal effect composition joins an already-running cleanup while repeated public disposer calls retain their upstream single-shot result. Effect creation is rejected while the owner is `UNLOADING` (while `PENDING` and `LOADING` remain legal), preventing cleanup-time registrations from escaping the unload snapshot. Child fibers register and receive their parent-owned disposer before `internal/plugin` publication, resolve dependency declarations added by that notification before activation, drain effects attached while pending, skip plugin execution when reentrant disposal invalidates the load epoch before its first checkpoint, and contain teardown-notification failures per observer so one callback cannot starve peers or interrupt ownership cleanup.
7. **`cordis/src/*.ts` JSDoc enrichment**: added `@param`/`@returns` tags and contract documentation (disposal semantics, waterfall veto, bail conditions, error cases) across the public plugin-author surface — `Context` (class, statics, and the `Context` interface properties incl. `root`), `EventsService`, `Fiber`, `RegistryService`, `ReflectService`, `Service`, `LoggerService` and their `declare module './context.ts'` overloads. Comment-only; no code changes. Motivation: the website API-reference generator renders these docs and hard-errors on undocumented members. Retire this entry when the enrichment is upstreamed to the fork.
8. **`include/src/index.ts` hot-reload hardening**: `refresh()` awaits the full read-and-update and catches failures (logging a warning and keeping the last good entry tree) instead of rethrowing — upstream's throw escaped `@cordisjs/plugin-hmr`'s async watcher callback as an unhandled rejection, so one bad `cordis.yml` edit killed a live app. `read()` rejects a non-array parse result (an empty or mid-write truncated file parses to `undefined`, which upstream later crashed on) and commits `content`/`data` only on success, so reverting an edit to the exact last good content reads as "unchanged". `refresh()` and the `internal/update` listener re-apply `config.patches` before `root.update()`, matching initial load; upstream applied patches only in `[Service.init]`, so any config hot-reload silently reverted overlay-patched entries and removed inserted ones. `applyPatches` deep-copies via `structuredClone` instead of mutating the cached parse (repeated application converges; removing a patch reverts), and the veto-style `internal/update` listener persists the incoming config itself (`Fiber.update` only assigns behind `next()`), so later re-reads use the new patches. `[Service.init]` falls back to `initial` only on `ENOENT`; an existing-but-invalid file fails loud with its real parse error instead of "config file not found" (or a silent overwrite). Covered by `packages/ui/app-boot/tests/config-reload.spec.ts`.
9. **Vendored Node-compatible TypeScript**: marked erased imports explicitly across `cordis`, `loader`, `include`, `hmr`, and `schemastery` so Node's native TypeScript transform does not request types as runtime exports. Schemastery's source uses an ESM default export and its package declares `type: module`; its built ESM/CJS entries retain explicit `.mjs`/`.cjs` extensions.

## Sync procedure

To update a vendored package from upstream:

1. In the upstream workspace, note `git rev-parse HEAD` of the relevant submodule.
2. Copy the package's `src/` (and `bin.js`, `README.md`, `LICENSE` if changed) over the vendored directory.
3. Re-apply the local modifications listed above (or drop them if upstream made them unnecessary — update the log either way).
4. Update the version and commit hash in the manifest table.
5. Run `pnpm install && pnpm run test && pnpm run build` at the repo root.
