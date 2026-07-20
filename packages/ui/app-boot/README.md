# `@deepseek-ai/dsh-app-boot`

Shared boot glue for the app bins ([`dsh-stdio-demo`](../../examples/stdio-demo/README.md), [`dsh-acp-demo`](../../examples/acp-demo/README.md)): each bin is a thin self-executing composition over these helpers, parameterized by its diagnostic prefix, so the loader-failure lore lives once — under the per-file coverage gate — instead of drifting between two published artifacts.

| Export | Role |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | Absolute config path; `snapshotMode === 'replay'` swaps a `cordis.yml`/`.yaml` basename for its sibling `cordis.snapshot.yml` |
| `loadEnv(binName, dir?, warn?)` | Load the gitignored `.env` (Node `process.loadEnvFile`); absent file is fine, an unloadable one warns a single labelled line (default: stderr) |
| `installFailLoud(binName, proc?)` | Turn a post-`boot()` unhandled Loader rejection into one labelled stderr line + `exit(1)`; returns the uninstaller (for tests) |
| `assertEntriesLoaded(ctx, binName)` | Throw when a settled tree holds an enabled entry with no fiber (a plugin module that failed to import) |
| `boot(binName, absoluteConfigPath)` | Mount the Loader, mount the statically imported include plugin as the `cordis:include` builtin (so the config may live outside `node_modules` reach), include the config by absolute `file://` URL, await the whole tree, assert entries loaded, return the root context |

Two failure classes the guards handle: `loader.await()` swallows init rejections (`Promise.allSettled`) — Node still exits non-zero on the resulting unhandled rejection, and `installFailLoud` replaces the noisy dump with one labelled line and a guaranteed `exit(1)`; a failed plugin IMPORT is only logged by the Loader (the process would otherwise exit 0 on a usable config typo), leaving a fiber-less entry that `assertEntriesLoaded` turns into a `boot()` rejection.

Bare plugin specifiers in a config (`@deepseek-ai/dsh-*`, npm packages) resolve through the cordis Loader's internal module loader when Node runs with `--expose-internals` or the optional `node-addon-require-builtin` fallback is installed; without either, consumers must install plugins where plain Node import resolution can find them. Relative specifiers resolve against the config directory with no flag. The bins' subprocess smokes exercise the internal-loader path, while this package's unit suite drives `boot()` in-process against configs with relative specifiers.

This package carries no loader hooks and no dev-mode surface: the `dsh-scripts` launcher ([`sdk/scripts`](../../sdk/scripts/README.md), with the shared project model in [`sdk/helper`](../../sdk/helper/README.md)) owns process startup, tsx registration, and local-plugin source resolution, and consumes these helpers for the boot sequence itself.

## Model Experience

Indirectly, through the plugin tree it loads, which determines the prompts, schemas, messages, and model adapter in the resulting application.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Bare package specifiers depend on Loader internals** — production bins need `node --expose-internals` or the Loader's optional native fallback; an in-process caller without either must use resolvable relative/file specifiers or tsx path mapping.
- **Snapshot replay swapping is basename-specific** — only a config ending in `cordis.yml` or `cordis.yaml` maps to the sibling `cordis.snapshot.yml`; custom config names require caller-managed selection.
- **Environment loading is cwd-scoped and optional** — the helper loads one `.env` file and warns on failure; it does not search parents, merge profiles, or validate required variables.
