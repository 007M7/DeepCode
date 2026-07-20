# Release

Pre-1.0: treat this as a release checklist, not a stability policy.

## Versioning

One version across every package in the repo. Use the bump helper:

```sh
pnpm release:bump patch          # or minor / major / x.y.z
```

It updates the root and every `packages/*` manifest, refreshes the lockfile (`--ignore-scripts --lockfile-only`), and runs `release:verify`. Explicit versions accept full semver including prereleases (`pnpm release:bump 0.0.0-test.0`); the publish workflow puts prerelease versions under the `next` dist-tag, so `latest` never points at a test build. Keep `workspace:*` dependencies in source; pnpm converts them to concrete versions during pack.

Version bumps are normal source changes: open a release PR (or commit) with the manifests and lockfile, merge it, then create the matching `vX.Y.Z` tag from that commit. The publish workflow validates that the tag matches every package version.

```sh
pnpm release:commit patch        # bump + stage + commit in one command
git tag v0.0.2
```

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm build:ts
pnpm typecheck
pnpm test:entry
```

On a Linux host, also rehearse the pack path locally:

```sh
pnpm build:native
pnpm test:launcher
node ./scripts/pack-release.mjs .release/npm --current-platform-only
node ./scripts/verify-packed-install.mjs .release/npm --current-platform-only
```

## Publish

Use the `Release` workflow so every binary is built on its matching native runner:

1. Run it with `publish=false` (from the release commit) to build all platform binaries, assemble and verify the payloads, pack the tarballs in publish order, rehearse the packed install, and upload the `npm-tarballs` artifact for inspection.
2. Create and push the `vX.Y.Z` tag matching the package versions.
3. Run the same workflow from that tag with `publish=true`.

The workflow publishes only from the final packed tarballs, in `publish-order.txt` order (platform packages before the entry that optionally depends on them). It supports npm trusted publishing through GitHub OIDC; without it, provide an `NPM_TOKEN` secret in the `npm-publish` environment. Packages publish with `--access public`.

Manual local fallback (current platform's packages only) — always through `pack-release.mjs`, never `pnpm publish` directly (pnpm's pack path strips the launcher's executable bit; see [packaging.md](packaging.md)):

```sh
node ./scripts/pack-release.mjs dist/npm --current-platform-only
node ./scripts/verify-packed-install.mjs dist/npm --current-platform-only
while IFS= read -r tarball; do npm publish "dist/npm/${tarball}" --access public; done < dist/npm/publish-order.txt
```

Do not commit `.npmrc` files with tokens or registry overrides.
