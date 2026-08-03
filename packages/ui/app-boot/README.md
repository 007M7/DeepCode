# `@deepseek-ai/dsh-app-boot`

English | [中文](README.zh.md)

Shared boot glue for the app bins ([`dsh`](../../../apps/cli/README.md), [`dsh-cli-demo`](../../examples/cli-demo/README.md), [`dsh-acp-demo`](../../examples/acp-demo/README.md)): each bin is a thin self-executing composition over these helpers, parameterized by its diagnostic prefix, so the loader-failure lore lives once — under the per-file coverage gate — instead of drifting between published artifacts.

| Export | Role |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | Absolute config path; `snapshotMode === 'replay'` swaps a `cordis.yml`/`.yaml` basename for its sibling `cordis.snapshot.yml` |
| `loadEnv(binName, dir?, warn?)` | Load the gitignored `.env` (Node `process.loadEnvFile`); absent file is fine, an unloadable one warns a single labelled line (default: stderr) |
| `installFailLoud(binName, proc?)` | Turn an unhandled boot or later Loader rejection into one labelled stderr line + `exit(1)`; returns the uninstaller (for tests) |
| `assertEntriesLoaded(ctx, binName)` | Throw when a settled tree holds an enabled entry with no fiber, reporting every unresolved plugin name as a Cordis startup failure |
| `assertEntriesActivated(ctx, binName)` | Include the `assertEntriesLoaded` check, then await every enabled entry after the Loader settles; throw with each failed plugin's original stack or each pending plugin's unresolved services |
| `loadPersonalPatches(binName, dir?)` | Parse the optional `config.yaml` in the Harness home (default [`resolveDshHome()`](../../util/paths/README.md): `$DSH_HOME`, else `~/.dsh`) — a top-level YAML array of include `PatchOptions` (id-targeted config overrides, `insert` lists, `!!js` allowed); absent file → `undefined`, an unreadable/unparsable/non-array file throws |
| `loadOverlayPatches(binName, file)` | Parse a required patch-list file with the same shape as personal config; read or parse failures throw a labelled error |
| `mountRootInclude(ctx, absoluteConfigPath, patches?)` | Mount the statically imported Include builtin and retain the exact root entry used by personal-config HMR |
| `watchPersonalPatches(ctx, options)` | Register `$DSH_HOME/config.yaml` with the existing Cordis HMR service; each add/change/removal transactionally recomposes the full patch list through the caller's `compose` closure (app-owned layers around the current personal overlay) and returns an async disposer |
| `boot(binName, absoluteConfigPath, patches?, prepare?)` | Create the root context, expose `dshHomePath(...segments)` to Loader `!!js` config expressions, install Loader, run optional host preparation before config-tree entries mount (`prepare` may use Loader and provide launcher-owned context slots such as [`MAIN_SESSION_ID_KEY`](../tui/README.md)), then mount and await the include tree, assert entries loaded and activated, and return the root context — or dispose the partial context and reject a labelled error |
| `renderConfigDump(binName, absoluteConfigPath, layers, warn?)` | Compose the base config and labeled overlay layers offline — the include's own parser and patch algorithm (`entryListSchema`/`applyEntryPatches`), so the result equals what `boot()` mounts — and render YAML with `!!js` expressions verbatim; each run of same-provenance rows is preceded by a `# ==` comment naming the contributing file and the layers that patched it, keeping the output one loadable document; a patch matching no row goes to `warn` with its layer label (default: one stderr line), read/parse/shape failures throw |
| `addHarnessSourceSection(ctx, sourceRoot)` | Add a global `harness:source` prompt section (ordered just after the harness identity, before the persona) telling the agent the on-disk path to the DSH implementation checkout while warning it not to infer the current working directory from that path and to use `pwd` instead; a no-op returning `undefined` when the booted tree has no `systemPrompt` service. The section is registered against that service's fiber, so a dev HMR reload of the system prompt drops it until the next boot |
| `HARNESS_SOURCE_SECTION` | The `'harness:source'` section name `addHarnessSourceSection` registers under |

Loader settlement rejects import and lifecycle failures with the failing entry and stage; `boot()` disposes the partial context and wraps that failure with the bin name. Entries settlement leaves behind are audited separately: `assertEntriesLoaded` turns an enabled fiber-less entry into a rejection naming every unresolved plugin, and `assertEntriesActivated` awaits each failed fiber to include its original stack in the startup rejection and names each pending entry's unresolved services. Before throwing, the audit marks those exact rejection reasons through one process checkpoint so `installFailLoud` coalesces Loader's duplicate notification while every unrelated unhandled rejection remains fatal.

Bare plugin specifiers in a config (`@deepseek-ai/dsh-*`, npm packages) resolve through the Cordis Loader's internal module loader. Repository bins install Loader's optional `node-addon-require-builtin` peer; external callers must supply it or install plugins where plain Node import resolution can find them. Relative specifiers resolve against the config directory without the native helper. The built `dsh-app-boot` artifact embeds the statically mounted Include implementation while leaving Loader external, so the include tree and host bind to one Loader peer. The `dsh` source launcher additionally maps manifest-declared workspace packages to their TypeScript source; its configuration gate requires every TUI/Web bare plugin to appear in the resolver manifest's `dependencies`. The bins' subprocess smokes exercise the internal-loader path, while this package's unit suite drives `boot()` in-process against configs with relative specifiers.

This package carries no loader hooks and no dev-mode surface. The [`dsh` app](../../../apps/cli/README.md) owns its Node source-launch hook and consumes these helpers for the boot sequence; built consumers continue to use plain Node package resolution.

## Personal config

A developer's machine-local preferences live outside every repository in the Harness home (default `~/.dsh`, overridable via `$DSH_HOME`; the single root [`resolveDshHome`](../../util/paths/README.md) resolves), consumed by the `dsh` CLI's TUI, Web, and headless surfaces ([`apps/cli`](../../../apps/cli/README.md)); the demo bins boot their committed trees verbatim. Two optional files:

- **`.env`** — the credential store of [`dsh-credentials-local`](../../credentials/credentials-local/README.md), read by that provider alone. No surface hoists it into `process.env`: doing so would make every stored key look like a read-only launch override on the next run, blocking rotation from the TUI and the web page. The environment layers are the ambient one and the invoking directory's `.env` (loaded by the bin; `process.loadEnvFile` never overrides), and a composition without the credential provider keeps resolving keys from those alone.
- **`config.yaml`** — loader overlay patches applied over the shipped default config, with the same semantics as the shipped surface overlays: an id-targeted patch replaces the named entry's whole `config` (restate unchanged fields), `insert` adds entries, and `!!js` expressions interpolate at mount. A patch naming an entry id absent from the booted tree is a silent no-op. An empty or comments-only file throws (it parses to nothing, not to a list); disable the overlay with `[]` or by deleting the file.

The TUI and Web keep `config.yaml` live through `watchPersonalPatches`; one-shot headless runs read only the startup value. The watcher targets the exact personal path even when the file or immediate parent does not exist, serializes bursts, and recomposes the personal patches inside the caller's layer order (surface overlay below, app-generated patches above). A rejected read, parse, or Loader candidate leaves the last good tree running and the HMR service broadcasts `hmr/config-update-failed(filename, Error)` after logging it; observer failures are contained. Disposing the context closes the watcher and drains an active refresh.

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
