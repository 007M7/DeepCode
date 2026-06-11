# ADR 0008: tsdown for JS bundling instead of dumble

Status: accepted (2026-06-11)

## Context

The initial build used **dumble**, the cordiverse zero-config esbuild wrapper
that upstream Cordis itself builds with — maximum alignment with the vendored
packages' conventions (it reads each package.json and infers entries/formats
from the `exports` field). But dumble is a liability as a load-bearing tool in
this repo: v0.2.x, ~530 npm downloads/week, effectively one maintainer, and we
were invoking it through a custom orchestration script (`scripts/build.ts`)
because it has no workspace mode.

Build output currently matters only for `yarn build` + publint (nothing
publishes yet; dev/test/demo run unbuilt via tsx), so the switching cost is at
its lowest now and only grows once packages publish.

## Decision

Replace dumble with **tsdown** (rolldown-based, ~2.5M downloads/week,
VoidZero-backed, actively released):

- Root `tsdown.config.ts` with `workspace: ['vendor/*', 'packages/*']`
  (explicit globs, not `workspace: true`, which would also pick up
  `examples/*` — they have package.json files but are not yarn workspaces).
- Shared shape: entry `src/index.ts`, `outDir: 'lib'`, ESM, `platform: node`,
  `target: es2024`, `fixedExtension: false` (keeps `.js` for
  `"type": "module"` packages), `dts: false` (tsc -b owns declarations),
  `clean: false` (lib/ holds tsc's .d.ts output).
- Two per-package overrides in vendor/ (ours, like the regenerated tsconfigs;
  logged in vendor/README.md): schemastery (dual `.mjs`/`.cjs` via
  `outExtensions`), logger-console (two single-entry passes so the shared
  base class is inlined into each entry instead of a hash-named chunk,
  matching upstream's published shape).
- `scripts/build.ts` deleted; `yarn build` = `tsc -b && tsdown`.

Alternatives considered: **direct esbuild script** (most established engine,
zero wrapper risk, but hand-maintains the per-package spec table tsdown's
workspace mode gives us); **pkgroll** (closest drop-in philosophically, but
78k dl/wk and Rollup-based — strictly weaker maintenance story than tsdown);
**keep dumble** (perfect upstream alignment, unacceptable bus factor).

## Consequences

Output file lists are byte-for-byte-list identical to dumble's (verified by
snapshot diff at migration time); externals still come from each package's
dependencies/peerDependencies. We give up dumble's exports-field inference —
new packages with non-default shapes need a per-package `tsdown.config.ts`
instead of just package.json fields. Future option: tsdown could also absorb
declaration bundling (isolatedDeclarations) if `tsc -b` ever becomes the
bottleneck; that would be a new ADR.
