# `@deepseek-ai/dsh-app-boot`

English | [中文](README.zh.md)

Shared boot glue for the app bins ([`dsh`](../../../apps/cli/README.md), [`dsh-cli-demo`](../../examples/cli-demo/README.md), [`dsh-acp-demo`](../../examples/acp-demo/README.md)): each bin is a thin self-executing composition over these helpers, parameterized by its diagnostic prefix, so the loader-failure lore lives once — under the per-file coverage gate — instead of drifting between published artifacts.

| Export | Role |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | Absolute config path; `snapshotMode === 'replay'` swaps a `cordis.yml`/`.yaml` basename for its sibling `cordis.snapshot.yml` |
| `loadEnv(binName, dir?, warn?)` | Load the gitignored `.env` (Node `process.loadEnvFile`); absent file is fine, an unloadable one warns a single labelled line (default: stderr) |
| `installFailLoud(binName, proc?)` | Turn a post-`boot()` unhandled Loader rejection into one labelled stderr line + `exit(1)`; returns the uninstaller (for tests) |
| `assertEntriesLoaded(ctx, binName)` | Throw when a settled tree holds an enabled entry with no fiber, reporting every unresolved plugin name as a Cordis startup failure |
| `assertEntriesActive(ctx, binName)` | Throw when a settled enabled fiber is not ACTIVE, including missing injected services for PENDING entries |
| `loadPersonalPatches(binName, dir?)` | Parse the optional `config.yaml` in the Harness home (default [`resolveDshHome()`](../../util/paths/README.md): `$DSH_HOME`, else `~/.dsh`) — a top-level YAML array of include `PatchOptions` (id-targeted config overrides, `insert` lists, `!!js` allowed); absent file → `undefined`, an unreadable/unparsable/non-array file throws |
| `loadOverlayPatches(binName, file)` | Parse a required patch-list file with the same shape as personal config; read or parse failures throw a labelled error |
| `boot(binName, absoluteConfigPath, patches?, prepare?)` | Create the root context, install Loader, run optional host preparation before config-tree entries mount (`prepare` may use Loader and provide launcher-owned context slots such as [`MAIN_SESSION_ID_KEY`](../tui/README.md)), then mount and await the include tree, assert entries loaded and ACTIVE, and return the root context |
| `addHarnessSourceSection(ctx, sourceRoot)` | Add a global `harness:source` prompt section (ordered just after the harness identity, before the persona) telling the agent the on-disk path to its own source checkout; a no-op returning `undefined` when the booted tree has no `systemPrompt` service. The section is registered against that service's fiber, so a dev HMR reload of the system prompt drops it until the next boot |
| `HARNESS_SOURCE_SECTION` | The `'harness:source'` section name `addHarnessSourceSection` registers under |

Two failure classes the guards handle: `loader.await()` swallows init rejections (`Promise.allSettled`) — Node still exits non-zero on the resulting unhandled rejection, and `installFailLoud` replaces the noisy dump with one labelled line and a guaranteed `exit(1)`; a failed plugin import is only logged by the Loader (the process would otherwise exit 0 on a usable config typo), leaving a fiber-less entry that `assertEntriesLoaded` turns into a `boot()` rejection naming every failed plugin.

Bare plugin specifiers in a config (`@deepseek-ai/dsh-*`, npm packages) resolve through the Cordis Loader's internal module loader. Repository bins install Loader's optional `node-addon-require-builtin` peer; external callers must supply it or install plugins where plain Node import resolution can find them. Relative specifiers resolve against the config directory without the native helper. The `dsh` source launcher additionally maps manifest-declared workspace packages to their TypeScript source; its configuration gate requires every TUI/Web bare plugin to appear in the resolver manifest's `dependencies`. The bins' subprocess smokes exercise the internal-loader path, while this package's unit suite drives `boot()` in-process against configs with relative specifiers.

This package carries no loader hooks and no dev-mode surface. The [`dsh` app](../../../apps/cli/README.md) owns its Node source-launch hook and consumes these helpers for the boot sequence; built consumers continue to use plain Node package resolution.

## Personal config

A developer's machine-local preferences live outside every repository in the Harness home (default `~/.dsh`, overridable via `$DSH_HOME`; the single root [`resolveDshHome`](../../util/paths/README.md) resolves), consumed by the official `dsh` surfaces ([`apps/cli`](../../../apps/cli/README.md)); the demo bins boot their committed trees verbatim. Two optional files:

- **`.env`** — the credential store of [`dsh-credentials-local`](../../credentials/credentials-local/README.md), read by that provider alone. No surface hoists it into `process.env`: doing so would make every stored key look like a read-only launch override on the next run, blocking rotation from the TUI and the web page. The environment layers are the ambient one and the invoking directory's `.env` (loaded by the bin; `process.loadEnvFile` never overrides), and a composition without the credential provider keeps resolving keys from those alone.
- **`config.yaml`** — loader overlay patches applied over the shipped default config, with the same semantics as the shipped surface overlays: an id-targeted patch replaces the named entry's whole `config` (restate unchanged fields), `insert` adds entries, and `!!js` expressions interpolate at mount. A patch naming an entry id absent from the booted tree is a silent no-op. An empty or comments-only file throws (it parses to nothing, not to a list); disable the overlay with `[]` or by deleting the file.

Subprocess test launchers point `DSH_HOME` at an isolated per-test directory so a developer's personal overlay can never leak into fixtures.

## Model Experience

Indirectly, through the plugin tree it loads, which determines the prompts, schemas, messages, and model adapter in the resulting application; the one export that contributes model-visible text, `addHarnessSourceSection`, does so only when a consumer calls it after boot.

#### KV Cache effect

No direct invalidation from `boot()`; a consumer that calls `addHarnessSourceSection` places one short line near the system prompt's head, before per-request content, so it does not invalidate the cache across turns, and any other request-prefix change is owned by the named consumer.

## Known Limitations and Deferred Work

- **Bare package specifiers depend on Loader internals** — production bins need Loader's optional native helper; an in-process caller without it must use resolvable relative/file specifiers or provide its own module-resolution hook.
- **Snapshot replay swapping is basename-specific** — only a config ending in `cordis.yml` or `cordis.yaml` maps to the sibling `cordis.snapshot.yml`; custom config names require caller-managed selection.
- **Environment loading is cwd-scoped and optional** — the helper loads one `.env` file and warns on failure; it does not search parents, merge profiles, or validate required variables.
- **Personal config is patch-shaped** — an id-targeted patch replaces the entry's whole `config` rather than deep-merging, so a personal override restates the base fields it keeps.
