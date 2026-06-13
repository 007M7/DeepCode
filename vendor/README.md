# Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries. They are copied into this monorepo instead of being depended on via npm, so that the harness fully owns its framework layer (auditable, patchable, pinned).

All vendored packages keep their **original npm names** (they are resolved through Yarn workspaces) and are marked `private: true` — they are never published from this repo. Upstream MIT `LICENSE` files are preserved in each package directory.

This file covers the manifest, the local-modification log, and the procedure for **updating** an existing vendored package. To **add a new** one, see the cookbook guide: [docs/cookbook/adding-a-vendored-package.md](../docs/cookbook/adding-a-vendored-package.md).

## Manifest

Upstream workspace: `cordis-workspace` (local checkout: `~/repos/cordis-workspace`).

| Directory | npm name | Version | Upstream repo | Commit |
|---|---|---|---|---|
| `cosmokit/` | `cosmokit` | 1.8.1 | https://github.com/deepseek-harness/cosmokit | `16f6fc058ade66e8ac5da0033d35a8d0f279f544` |
| `schemastery/` | `schemastery` | 3.18.0 | https://github.com/deepseek-harness/schemastery (`packages/core`) | `e67cee00ad725bd1534aee930a979ea3eec6f698` |
| `cordis/` | `cordis` | 4.0.0-rc.6 | https://github.com/deepseek-harness/cordis (`packages/core`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `loader/` | `@cordisjs/plugin-loader` | 1.0.0-rc.4 | https://github.com/deepseek-harness/cordis (`packages/loader`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `include/` | `@cordisjs/plugin-include` | 1.0.4 | https://github.com/deepseek-harness/cordis (`packages/include`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `group/` | `@cordisjs/plugin-group` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/group`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `timer/` | `@cordisjs/plugin-timer` | 1.1.2 | https://github.com/deepseek-harness/cordis (`packages/timer`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `hmr/` | `@cordisjs/plugin-hmr` | 1.0.15 | https://github.com/deepseek-harness/cordis (`packages/hmr`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `logger-console/` | `@cordisjs/plugin-logger-console` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/logger-console`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |

Third-party dependencies of the vendored packages stay on npm: `@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`, `supports-color`.

Intentionally **not** vendored (verified unused by this set): `reggol`, `@cordisjs/utils`, `@cordisjs/element`, `@cordisjs/unyaml` (dev-time YAML import hook only).

## Local modifications

Keep this log exhaustive — every divergence from upstream must be listed.

1. **`hmr/src/index.ts`**: removed the `./locales/en-US.yml` / `./locales/zh-CN.yml` imports, the `.i18n({...})` call on the `Config` schema, and the `src/locales/` directory. Rationale: those imports require a runtime YAML loader hook (`@cordisjs/unyaml`) that we do not vendor; the i18n texts only localize config descriptions.
2. **All `package.json` files**: regenerated — added `private: true`, added `src` to `files` and a `./src/*` export where missing, removed upstream `devDependencies`/`scripts`/`repository` fields. Dependency and peer-dependency ranges preserved.
3. **All `tsconfig.json` files**: regenerated to extend the repo-root `tsconfig.base.json` and declare project references.
4. **`schemastery/tsdown.config.ts` and `logger-console/tsdown.config.ts`**: ours, not upstream files — per-package build-shape overrides (dual ESM+CJS output; separate node/browser entries) for the repo-root tsdown build. Like the regenerated tsconfigs, they are not part of the upstream sync surface.

## Sync procedure

To update a vendored package from upstream:

1. In the upstream workspace, note `git rev-parse HEAD` of the relevant submodule.
2. Copy the package's `src/` (and `bin.js`, `README.md`, `LICENSE` if changed) over the vendored directory.
3. Re-apply the local modifications listed above (or drop them if upstream made them unnecessary — update the log either way).
4. Update the version and commit hash in the manifest table.
5. Run `yarn install && yarn test && yarn build` at the repo root.
