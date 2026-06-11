# AGENTS.md

This is the monorepo for the DeepSeek Harness group. It currently hosts the code for **DeepSeek Code**, DeepSeek's coding agent product.

## Architecture

This codebase is based on the **Cordis** framework, built microkernel-style: **everything is a plugin**. All necessary Cordis dependencies are copied into this monorepo as vendored source (under `vendor/`) instead of being depended on via npm.

Read [docs/architecture.md](docs/architecture.md) before changing anything under `packages/` — it defines the service map, the event taxonomy, the session/turn/step lifecycle, and the plugin cookbook.

## Design Documents

- [Coding Harness MVP 需求分析](https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg) — requirement analysis for the initial MVP.
- [微内核Harness实现思路](https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc) — discussion of the microkernel plugin-style architecture ("everything is a plugin").

## Repository Layout

```
vendor/      Vendored Cordis framework source (original npm names, private).
             See vendor/README.md for the manifest, local-modification log,
             and the upstream sync procedure. Do NOT edit casually — every
             divergence must be logged there.
packages/    Harness packages, all named @deepseek-ai/dsh-<name>:
  llm/            abstract LLM service + content-block vocabulary (no real adapter yet)
  session/        event-sourced session log + in-memory store
  system-prompt/  prompt-section + tool-schema assembly registry
  tools/          tool registry + tools/execute waterfall
  agent/          Agent interface, registry, agent/* event vocabulary
  agent-loop/     THE concrete plugin: LoopAgent + the loop driver
examples/    Runnable demos (not workspaces). echo-agent = mock model + echo
             tool + stdio UI + JSONL persistence, wired via cordis.yml.
docs/        architecture.md — the design doc.
scripts/     build.ts — dumble JS bundling for all packages.
```

## Commands

```sh
yarn install        # Yarn 4 workspaces (node-modules linker), node >= 24
yarn test           # vitest run (packages/*/tests/**/*.spec.ts)
yarn typecheck      # tsc -b tsconfig.build.json (declarations only)
yarn build          # typecheck + dumble JS bundles into each package's lib/
yarn demo           # run examples/echo-agent (needs --expose-internals, the
                    # script passes it; type "echo hi" to see a tool call)
```

Dev/test/demo run **unbuilt** via tsx + the `paths` map in the root
`tsconfig.json` (`vitest` resolves through `tsconfig.test.json`). Building is
only needed for publishing/consumption outside the repo.

## Conventions

- **Package naming**: every npm package in this repo is `@deepseek-ai/dsh-<name>`
  (vendored packages keep their upstream names and are `private: true`).
- **ESM everywhere** (`"type": "module"`); imports between workspace packages
  use package names, never relative paths across package boundaries.
  In-package imports use explicit `.ts` extensions (allowImportingTsExtensions).
- **`cordis` is a peerDependency** (+ devDependency) of every harness package,
  mirroring upstream convention.
- **Registrations are effects**: anything a plugin contributes (adapter, tool,
  section, agent, event listener) goes through `ctx.effect()` / `ctx.on()` so
  disposal and HMR work. If you write a registry, `register()` must return the
  disposer.
- **Typed events via declaration merging**: services declare their events in
  `declare module 'cordis' { interface Events { … } }`, and their ctx key in
  `interface Context`. Extensible unions use the merge-extensible-map pattern
  (see `ContentBlockMap`, `MessageSourceMap`).
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)`
  and MUST call `next()` to delegate; returning without it short-circuits.
  This is the veto mechanism — use deliberately.
- **Plugins, not loop changes**: new behavior goes into a plugin on the
  documented extension seams (see the plugin sanity checklist in
  docs/architecture.md). Changing `agent-loop` requires updating that doc.
- **Tests**: vitest, colocated under `packages/<name>/tests/*.spec.ts`. Every
  registry needs an HMR-safety test (dispose the contributing fiber, assert
  cleanup).

## Vendoring Policy

`vendor/` packages are pinned source copies (manifest with upstream commit
SHAs in [vendor/README.md](vendor/README.md)). To update one, follow the sync
procedure there; re-apply (or retire) the logged local modifications and rerun
`yarn test && yarn build`.
