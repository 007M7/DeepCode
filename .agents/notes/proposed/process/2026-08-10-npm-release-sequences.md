# Agent Note: Private npm publication as three independent sequences

Status: proposed

English | [中文](2026-08-10-npm-release-sequences.zh.md)

## Problem

This repository holds three unrelated groups of publishable packages and no channel that sends any of them to a registry.

`packages/*/*` and `apps/*` form the runtime surface of `@deepseek-ai/dsh`; `vendor/*` holds nine rescoped Cordis framework packages, each carrying its upstream version; `native/landlock-run/packages/*` holds Linux platform packages that already have `landlock-run-release.yml`. The three differ in version baseline, change rate, and build requirements: dsh moves with the product, vendor moves only when upstream is re-synced or a local modification changes, and native needs a musl toolchain and one build per architecture. Forcing them through one pipeline means every product release republishes the framework and the native binaries.

Two hard blockers sit in the current state. All 217 workspace manifests set `private: true`, which npm refuses to publish. The subtler one is 933 hard-written `peerDependencies: "^0.0.1"` entries between sibling dsh packages: `pnpm pack` substitutes the `workspace:` protocol but leaves semver ranges alone, and `^0.0.1` means `>=0.0.1 <0.0.2` — it excludes `0.0.2`, and semver excludes prereleases from a range without a prerelease of its own, so it excludes `0.0.1-rc.1` too. Those 933 entries have never failed only because the version has never left `0.0.1`.

The existing `scripts/publish-npm-baseline.ts` is a local publication script: it packs and publishes in one process, needs a human to authenticate and retry on their own machine, and excludes vendor from its release set. It cannot be the basis for CI publication, but its tarball payload validation and installed-artifact probes are verified parts.

## Proposal

### Three independent sequences

`packages/`, `vendor/`, and `native/` each get one bump sequence and one publication, sharing no version, no trigger, and no waiting. Releasing dsh does not republish vendor; releasing vendor does not republish native.

| Sequence | Members | Version baseline | Tag | Workflow |
|---|---|---|---|---|
| dsh | `packages/*/*` + `apps/*` (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-frontend`) | one version for the whole family, `0.0.x` | `dsh-v<version>` | `release.yml` (new) |
| vendored framework | the nine `vendor/*` packages | each package on its own version line | `vendor-<package>-v<version>` (one per package) | `release-vendor.yml` (new) |
| native | `native/landlock-run/packages/*` | its own `0.0.x` | `landlock-run-v<version>` | `landlock-run-release.yml` (unchanged) |

All three publish privately to the `@deepseek-ai` scope on npmjs.com (`npm publish --access restricted`).

### Versions land in the repository from a local command; CI only checks and uploads

Each sequence has one `bump and commit` command: derive the target version, write it into the relevant manifests, run `pnpm install --lockfile-only`, self-check immediately, then `git add` the manifests and the lockfile and commit. The published version is therefore readable from the repository, and "which version went out" is never a question. A human creates the tag after the commit merges to master; CI never writes to the repository and needs no write permission.

The dsh sequence shares one version across the family and accepts `major | minor | patch | x.y.z`. A prerelease version such as `0.0.1-rc.1` drives pack, the installed-artifact probes, and one real private publication end to end first; numbered versions like `0.0.1` and `0.0.2` follow once that passes. The dist-tag decision is the one this repository already makes in `landlock-run-release.yml`: a version with a prerelease segment publishes under `--tag next`, anything else takes `latest`.

### vendor: publish what changed, and let tags be the ledger

The vendored packages are decoupled from upstream by their scope but keep their own version lines. The published version is the upstream version with its prerelease segment dropped and its patch incremented:

| Package | Upstream version | First published version |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

Only changed packages publish, and the change judgement adds no state file: **each package has its own tag, and that tag records the commit it last published from**. For each package, bump reads the newest `vendor-<package>-v*` tag and runs `git diff <that tag>..HEAD -- vendor/<directory>`; a difference means patch+1, no difference means skip, and a missing tag means the first publication from the table above. The diff considers only paths that reach the tarball (the `files` rules in `scripts/publication-payload.ts`), so editing a comment inside a vendored package does not trigger a release.

A tag is a commit pointer, not proof of publication — a tag created for a publication that then failed must be recognizable. So bump also asks the registry whether the version that tag names exists, and fails for a human to resolve when it does not, rather than guessing. Querying a private package needs authentication; the check is skipped on a machine that is not logged in and enforced in CI.

The dependency ranges *inside* the nine vendored packages need no rewrite: `^1.8.1` admits `1.8.2` and `^1.0.0-rc.5` admits `1.0.1`, so patch+1 always lands inside the range.

### Publication runs only on GitHub, and the registry decides what goes out

Publication runs only from GitHub Actions; there is no local publication path. That makes the registry check a mandatory CI step instead of something with a bypass for an unauthenticated machine.

Publish reads no tag and no manifest of "what this release includes". For each member it compares the manifest version against the registry, in three states:

| State | Action |
|---|---|
| the registry does not have that version | publish |
| the registry has it, and the tarball's sha512 equals the recorded `dist.integrity` | skip: this is a re-run over one artifact |
| the registry has it, and the integrity differs | fail, reporting content changed without a version bump |

The third state is the point of the rule: it catches code that changed without a version bump. The first two provide idempotence — re-running publish over one artifact republishes nothing and needs no manual selection of packages.

The same rule resolves the tension between one vendor release carrying several tags and a workflow that can only run from one ref: the workflow never infers which packages to publish from the tag it ran from. The dsh sequence behaves identically with one version: the difference is either the whole set or nothing.

The third state depends on a reproducible build — packing the same commit twice must produce the same bytes. That must be measured, not assumed: if `pnpm run build` embeds absolute paths or timestamps, integrity drifts while content is unchanged and the third state reports a false failure. Before this lands, pack the same commit twice in CI and compare integrity; if it is not reproducible, compare per-file content hashes inside the tarball instead and exclude the fields that drift.

### Rewrite workspace-internal references to `workspace:^`, once

Every reference to a workspace member becomes `workspace:^`, so `pnpm pack` substitutes a range that matches the target version:

| Surface | Count | Effect |
|---|---|---|
| sibling dsh `peerDependencies` | 933 | `0.0.2` and `0.0.1-rc.1` both get a matching range |
| dep / peer / devDep pointing at vendor | 105 + 221 + 218 | no dsh-side rewrite after a vendor patch+1, and no range that goes stale as vendor increments |

`scripts/check-workspace-constraints.ts` currently asserts that the vendor peer and dev ranges are equal; both become `workspace:^`, so the assertion still holds but its wording changes with it.

This is what makes "no dependency rewriting at publication time" possible: publication does one thing, which is packing bytes.

### Release family objects

The entity in this domain is a **release family**: a set of packages sharing one version baseline and tag naming that publishes as a unit. Adding a family means adding a family description and one workflow lane, not changing the core.

| Object | Responsibility |
|---|---|
| `ReleaseFamily` | a family's identity: member discovery, version policy, tag naming, publish target. A new release family lands here |
| `ReleaseMember` | one publishable package: directory, manifest, family, position in publish order |
| `VersionPolicy` | where the version comes from. `SharedSemver` (dsh: one version for the family) and `PerPackageChanged` (vendor: change judged by tag, prerelease dropped, patch incremented) |
| `ReleaseSet` | a family's members in topological order over `dependencies`, ties broken by package name for determinism |
| `PackedBundle` | the tarballs plus `publish-order.txt` and its metadata: the only handoff between pack and publish |
| `PublishTarget` | registry, access, dist-tag, credential source. The dist-tag derives from the version's shape |
| `VersionInvariant` | the family's versions agree; publication runs from the family's tag; the tag version equals the package version; the target version is absent from the registry |
| `PayloadInvariant` | tarball content validation, reusing `scripts/publication-payload.ts` |
| `InstalledProbe` | a throwaway consumer outside the repository installs from the tarballs and drives the installed entry with plain Node: `dsh --version`, `dsh --dump-default-config`, and one TUI startup to ready and exit. Moved over from `scripts/publish-npm-baseline.ts` |

### Workflow shape: pack everything at once, then publish as one set

The shape comes from the reference flow (`release.yml` and `scripts/pack-release.mjs` in node-addon-require-builtin): the `pack` job walks the whole release set once, running `pnpm --dir <directory> pack --pack-destination <one directory>` per member, writes `publish-order.txt`, and uploads that directory as **one** artifact; the `publish` job downloads that artifact and runs `npm publish` per entry in `publish-order.txt`. The release set is one unit — half the packages can never reach the registry while the other half is still building.

The `pack` job carries no credentials: install, verify, build, pack, installed-artifact verification, upload-artifact. The `publish` job sits behind the `npm-publish` environment for human approval, runs `setup-node` and `download-artifact` only, and **neither checks out nor builds** — it uploads the bytes pack produced. Checkout uses `fetch-depth: 0`, because the vendor change judgement reads history and tags.

The environment is the only brake in the flow: pack has no credentials and can be rehearsed freely, and only publish stops for approval. GitHub needs an `NPM_TOKEN` secret (an automation token with publish rights on the scope) and an `npm-publish` environment (required reviewers, allowed tags limited to `dsh-v*`, `vendor-*`, and `landlock-run-v*`).

### Pull requests run as far as pack

The reference flow only has `workflow_dispatch`, so it verifies nothing on a pull request. Here `pull_request` runs the full pack: install, verify, build, pack per member, upload the tarball artifact. What it proves is that this release set still packs completely; it uses no credentials, touches no registry, and runs for pull requests from forks. The artifacts' own correctness is covered by existing tests and is not repeated at this layer.

The publication path is exercised from master: `push: master` runs the same pack rehearsal as a post-merge regression, and `workflow_dispatch` with `publish: true` performs a real publication from a tag.

### Repository changes

| Item | Content |
|---|---|
| release-set manifests | drop `private: true`; add `publishConfig.access: restricted` and `repository` (`git+https://github.com/deepseek-ai/deepseek-harness.git` plus each package's `directory`) |
| release-set boundary | every member of `packages/*/*`, `apps/*`, and `vendor/*`; no smaller selection |
| dependency protocol | workspace-internal references become `workspace:^`, with `check-workspace-constraints.ts` updated |
| root `AGENTS.md` | it states that vendored packages are rescoped and `private: true`; vendor now publishes, so that convention changes |
| `vendor/README.md` | its manifest table records the upstream version, kept distinct from the version we publish |
| the three native packages | `publishConfig.access` moves from `public` to `restricted`; they have never been published, so no anonymous install path exists to preserve |

### Relationship to the existing proposal

This Agent Note replaces the version scheme and the release-set boundary in [artifact-first npm baseline publication](2026-08-04-artifact-first-npm-baseline-publication.md): its `<base>-<timestamp>-<short SHA>` prerelease versions and `dev-<base>` dist-tag are not adopted, and vendor is no longer excluded from the release set. What both agree on stays: pack and publish are separate, publish consumes only verified tarballs, and the payload and installed-artifact probes are release gates.

## Alternatives considered

**A `<base>-<timestamp>-<short SHA>` version.** Planned for continuous dev publication. It conflicts with keeping the published version in the repository: the version embeds a commit SHA, and writing the version back produces a new commit, so the SHA can only name the parent commit that was published and the link needs a convention to explain it. With numbered versions, a prerelease such as `0.0.1-rc.1` already covers "verify first, then release".

**A `vendor/published.json` ledger recording each package's published version and commit.** This preceded the tag design. It adds a state file that must not drift from the registry. A per-package tag gives the same commit pointer, and the tag has to exist anyway, so it introduces no second copy of the state.

**Event-level tags (`vendor-r1`, `vendor-r2`).** Prepared for one release event carrying several package versions. Once the registry decides what publishes, the workflow no longer infers the set from the tag, so per-package tags suffice — and each one names its own package's real version.

**Putting the nine vendored packages on one `4.0.x` line.** It removes change detection, but cosmokit would jump from `1.8.1` to `4.0.1` and lose its upstream lineage; the upstream ranges inside the nine (`^1.8.1` and friends) would stop matching immediately, forcing a rewrite of the vendored manifests.

**Incrementing every vendored package on every vendor release, with no change detection.** The least machinery, at the cost of new version numbers for packages whose content is byte-identical to the previous release. Tags reduce change detection to reading one tag and running one diff, which is not worth trading for inflated version numbers.

**Deciding "already published" from the version alone, without comparing content.** The reference flow queries no registry at all: publish uploads each tarball and npm rejects a duplicate version. Skipping on the version alone misses code that changed without a bump, which is the only failure that quietly leaves stale bytes on the registry. The cost is a registry query and a dependency on reproducible builds.

**Verifying only the packed install, with no local registry.** This is what the reference flow does: unpack the tarballs into a tree and drive it with plain Node. It bypasses version-range resolution, so in principle it cannot prove that 200-odd interdependent packages install from a registry. Running a local registry in CI to cover that layer was proposed and rejected: artifact correctness is already covered by existing tests, the publication path is exercised by the master rehearsal, and a pull request only needs to prove the release set packs.

**Selecting a subset by entry closure.** Crawling `dependencies` from `@deepseek-ai/dsh` and `@deepseek-ai/dsh-frontend` yields 156 packages, 61 fewer than the whole set. But this repository's plugins are mounted by name from `cordis.yml` rather than imported: `vendor/cordis-plugin-group` and `vendor/cordis-plugin-logger-console` fall outside the dependency closure while being required at runtime. Selecting by code dependency fails as "the consumer installs it and it will not start", and it would need a standing proof that no mounted package was missed. The release set is therefore all of `packages/*/*`, `apps/*`, and `vendor/*`; under a private scope the extra packages are invisible outside the organization. `python/`, the root `examples/`, `docs/`, and `website/` are not members.

**Extending `scripts/publish-npm-baseline.ts`.** It is a local publication script that packs and publishes in one process, the opposite of separating credential-free packing from protected publication. Its verified parts — payload validation and installed-artifact probes — are reused so `pnpm run duplication` does not report clones.

**One workflow with a `family` input.** Two version models in one file forks the concurrency group, the tag prefix, and the rehearsal triggers into conditional expressions. One file per family is both shorter and easier to read.

**Rewriting dependency ranges at publication time.** Compared with rewriting them to `workspace:^` once, the rewrite runs only in CI, a local `pnpm install` cannot show whether it is correct, and it repeats on every release.

**Running bump in CI and pushing the version back.** It needs repository write permission for the workflow, and a version commit on the release branch races human commits. The reference flow leaves bump and commit to local commands and lets CI check and upload.

## Acceptance criteria

1. The three sequences release independently: releasing dsh modifies no vendor or native manifest, and the converse holds.
2. `pnpm release:dsh <version>` performs bump and commit in one command, and the resulting commit carries the family's manifests and the lockfile and self-checks immediately.
3. `pnpm release:vendor` increments the patch only for packages whose tarball content changed since their `vendor-<package>-v*` tag, and leaves the manifests of unchanged packages alone.
4. `pull_request` runs the full pack and produces the tarball artifact, with no credentials and no access to a real registry, including for pull requests from forks.
5. `push: master` runs the same pack rehearsal; a real publication can only come from `workflow_dispatch` with `publish: true` from that family's tag.
6. Re-running publish over one artifact republishes no existing version, and when a version exists whose tarball integrity differs, publish fails and names the package.
7. A throwaway consumer outside the repository installs `@deepseek-ai/dsh@0.0.1-rc.1` and drives `--version`, `--dump-default-config`, and one TUI startup with plain Node.
8. Every workspace-internal reference is `workspace:^`, the packed tarballs carry no `workspace:` remnant, and no range points at a version that does not exist.
9. No release-set member sets `private: true`, and each one sets `publishConfig.access: restricted`.

## Risks

**Tags drifting from the registry.** A tag created for a publication that then failed makes the next bump treat the package as published. Bump asks the registry whether the version the tag names exists and fails when it does not; on a machine that is not logged in to the private registry that check is skipped, and only the same check in CI catches it.

**The change judgement depends on visible tags.** A shallow clone, or a checkout without tags, breaks the vendor judgement and degrades it to "publish everything for the first time". `fetch-depth: 0` is a precondition of the judgement, not an optimization.

**`workspace:^` touches a large surface.** It rewrites 1477 dependency declarations at once. It does not change local resolution — pnpm already resolves from the workspace — but it changes the ranges that go out, and the workspace constraint gate changes with it.

**The visibility cost of private packages.** After `--access restricted`, every consumer — CI, sandbox e2e, and outside users — needs scope credentials to install. The three native packages move to `restricted` as well; they have never been published, so no existing anonymous install path is cut off.

**The `repository` organization differs from the one running the workflow.** The release set names `github.com/deepseek-ai/deepseek-harness` while the workflow runs in `deepseek-harness/deepseek-harness`. Token-based publication is unaffected; npm provenance (OIDC) requires the two to agree, so adopting it means either changing `repository` or publishing from the public repository.

**The first publication is one large step.** Nine vendored packages and the whole dsh set publish at once, so any payload defect surfaces in a single release. Driving the complete path with `0.0.1-rc.1` first is the only mitigation, which is why numbered versions wait for that to pass.
