# `@deepseek-ai/dsh-app-boot`

Shared boot glue for the app bins ([`dsh-stdio-agent`](../stdio-agent/README.md), [`dsh-acp-agent`](../acp-agent/README.md)): each bin is a thin self-executing composition over these helpers, parameterized by its diagnostic prefix, so the loader-failure lore lives once — under the per-file coverage gate — instead of drifting between two published artifacts.

| Export | Role |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | Absolute config path; `snapshotMode === 'replay'` swaps a `cordis.yml`/`.yaml` basename for its sibling `cordis.snapshot.yml` |
| `loadEnv(binName, dir?, warn?)` | Load the gitignored `.env` (Node `process.loadEnvFile`); absent file is fine, an unloadable one warns a single labelled line (default: stderr) |
| `installFailLoud(binName, proc?)` | Turn a post-`boot()` unhandled Loader rejection into one labelled stderr line + `exit(1)`; returns the uninstaller (for tests) |
| `assertEntriesLoaded(ctx, binName)` | Throw when a settled tree holds an enabled entry with no fiber (a plugin module that failed to import) |
| `boot(binName, absoluteConfigPath)` | Mount the Loader, include the config by absolute `file://` URL, await the whole tree, assert entries loaded, return the root context |

Two failure classes the guards handle: `loader.await()` swallows init rejections (`Promise.allSettled`) — Node still exits non-zero on the resulting unhandled rejection, and `installFailLoud` replaces the noisy dump with one labelled line and a guaranteed `exit(1)`; a failed plugin IMPORT is only logged by the Loader (the process would otherwise exit 0 on a usable config typo), leaving a fiber-less entry that `assertEntriesLoaded` turns into a `boot()` rejection.

Bare plugin specifiers in a config (`@deepseek-ai/dsh-*`) resolve through the cordis Loader's internal module loader, active only under `node --expose-internals`; the bins' subprocess smokes exercise that path, while this package's unit suite drives `boot()` in-process against configs with relative specifiers.
