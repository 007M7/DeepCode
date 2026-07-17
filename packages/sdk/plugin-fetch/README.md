# `@deepseek-ai/dsh-plugin-fetch`

Fetch an external Cordis plugin into a temp directory — pinned to an immutable commit or integrity and never executed — for the forthcoming `dsh-sdk create <source>` command.

The package parses a source spec into a `PluginSource`, dispatches to the matching `PluginFetcher`, and returns a common `FetchedPlugin` (temp dir + immutable provenance) that the wiring step pins into `package.json`, mounts in `cordis.yml`, and installs with `--ignore-scripts`.

| Export | Role |
|---|---|
| `resolvePluginSource(spec)` → `PluginSource` | Parse `owner/repo[/subdir]#ref` (github) or `pkg@version` (npm); fail loud on an ambiguous or malformed spec |
| `PluginFetcher<S>` | The fetch seam: resolve the pin BEFORE download, extract without executing pulled code |
| `GigetFetcher` / `createGigetFetcher()` | Github fetcher over `@bluwy/giget-core`: resolve `#ref` to a commit SHA, download that SHA |
| `PacoteFetcher` / `createPacoteFetcher()` | Npm fetcher over `pacote`: resolve the manifest, then extract the tarball verified against its integrity |
| `fetchPlugin(source, fetchers)` → `FetchedPlugin` | Dispatch one source to its fetcher by discriminant tag |

## Safety model — confirm-before-run, not run-on-fetch

A fetch only downloads and unpacks; it runs no install, no `postinstall`/`prepare`, and no degit-style template actions.

- **github** uses `@bluwy/giget-core` (one runtime dependency, `modern-tar`; no CLI, install, or JSON-registry surface) so a fetch can only download and untar a tarball. The commit is pinned first: `GigetFetcher` resolves `#ref` — or the default branch when absent — to an immutable SHA via the GitHub commits API, then downloads that SHA. Provenance carries the SHA so wiring pins `github:owner/repo#<sha>`.
- **npm** uses `pacote`. Registry-only is enforced upstream: `resolvePluginSource` produces only a `name@version` registry spec, so pacote never sees a git/file/dir spec whose lifecycle scripts would run, and a registry tarball extract is a plain untar. The manifest is resolved first so extract verifies the artifact against the registry-published integrity (a mismatch raises `EINTEGRITY`). Provenance carries the exact version, resolved URL, and integrity.

Both network boundaries (giget download, GitHub ref resolution, pacote, temp-dir allocation) are constructor-injected, so the fetch logic is unit-tested without network; the `create*Fetcher()` factories wire the real libraries.

## Model Experience

None, as this developer tooling acquires plugin sources for the SDK launcher and registers no live agent or model surface.

## Known Limitations and Deferred Work

- **Wiring is not here yet** — pinning `package.json`, mounting `cordis.yml` through `ProjectEditSession` with a confirmed diff, and `install --ignore-scripts` land with the `dsh-sdk create` command. This package stops at a fetched, pinned temp directory.
- **npm registry authentication** — `PacoteFetcher` targets a public or default-configured registry; private-registry auth beyond pacote's ambient npm config is deferred.
- **Template-repo initialization** — the whole-project init mode (`dsh-sdk create` from a template repository) is out of scope; this package fetches a single plugin into an existing project.
