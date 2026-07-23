# `@deepseek-ai/dsh-app-boot`

Shared boot glue for the app bins ([`dsh-tui-demo`](../../examples/tui-demo/README.md), [`dsh-cli-demo`](../../examples/cli-demo/README.md), [`dsh-acp-demo`](../../examples/acp-demo/README.md)): each bin is a thin self-executing composition over these helpers, parameterized by its diagnostic prefix, so the loader-failure lore lives once — under the per-file coverage gate — instead of drifting between published artifacts.

| Export | Role |
|---|---|
| `resolveConfigPath(path, snapshotMode, cwd?)` | Absolute config path; `snapshotMode === 'replay'` swaps a `cordis.yml`/`.yaml` basename for its sibling `cordis.snapshot.yml` |
| `parseResumeArg(argv)` | Split the `--resume <id>` / `--resume=<id>` flag out of the arguments, returning `{ resumeSessionId, rest }`; a valueless, empty, or repeated flag throws so a mistyped resume fails loud instead of silently starting fresh |
| `loadEnv(binName, dir?, warn?)` | Load the gitignored `.env` (Node `process.loadEnvFile`); absent file is fine, an unloadable one warns a single labelled line (default: stderr) |
| `installFailLoud(binName, proc?)` | Turn a post-`boot()` unhandled Loader rejection into one labelled stderr line + `exit(1)`; returns the uninstaller (for tests) |
| `assertEntriesLoaded(ctx, binName)` | Throw when a settled tree holds an enabled entry with no fiber (a plugin module that failed to import) |
| `loadPersonalPatches(binName, dir?)` | Parse the optional `config.yaml` in the Harness home (default [`resolveDshHome()`](../../util/paths/README.md): `$DSH_HOME`, else `~/.dsh`) — a top-level YAML array of include `PatchOptions` (id-targeted config overrides, `insert` lists, `!!js` allowed); absent file → `undefined`, an unreadable/unparsable/non-array file throws |
| `boot(binName, absoluteConfigPath, patches?)` | Mount the Loader, mount the statically imported include plugin as the `cordis:include` builtin (so the config may live outside `node_modules` reach), include the config by absolute `file://` URL with the optional overlay patches, await the whole tree, assert entries loaded, return the root context |
| `addHarnessSourceSection(ctx, sourceRoot)` | Add a global `harness:source` prompt section (ordered just after the harness identity, before the persona) telling the agent the on-disk path to its own source checkout; a no-op returning `undefined` when the booted tree has no `systemPrompt` service. The section is registered against that service's fiber, so a dev HMR reload of the system prompt drops it until the next boot |
| `HARNESS_SOURCE_SECTION` | The `'harness:source'` section name `addHarnessSourceSection` registers under |

Two failure classes the guards handle: `loader.await()` swallows init rejections (`Promise.allSettled`) — Node still exits non-zero on the resulting unhandled rejection, and `installFailLoud` replaces the noisy dump with one labelled line and a guaranteed `exit(1)`; a failed plugin IMPORT is only logged by the Loader (the process would otherwise exit 0 on a usable config typo), leaving a fiber-less entry that `assertEntriesLoaded` turns into a `boot()` rejection.

Bare plugin specifiers in a config (`@deepseek-ai/dsh-*`, npm packages) resolve through the Cordis Loader's internal module loader. Repository bins install Loader's optional `node-addon-require-builtin` peer; external callers must supply it or install plugins where plain Node import resolution can find them. Relative specifiers resolve against the config directory without the native helper. The bins' subprocess smokes exercise the internal-loader path, while this package's unit suite drives `boot()` in-process against configs with relative specifiers.

This package carries no loader hooks and no dev-mode surface: the `dsh-scripts` launcher ([`sdk/scripts`](../../sdk/scripts/README.md), with the shared project model in [`sdk/helper`](../../sdk/helper/README.md)) owns process startup, tsx registration, and local-plugin source resolution, and consumes these helpers for the boot sequence itself.

## Personal config

A developer's machine-local preferences live outside every repository in the Harness home (default `~/.dsh`, overridable via `$DSH_HOME`; the single root [`resolveDshHome`](../../util/paths/README.md) resolves), consumed by the `dsh` CLI's TUI surface ([`apps/cli`](../../../apps/cli/README.md)); the demo bins boot their committed trees verbatim. Two optional files:

- **`.env`** — loaded after the invoking directory's `.env`; `process.loadEnvFile` never overrides, so precedence is ambient environment > project `.env` > personal `.env`.
- **`config.yaml`** — loader overlay patches applied over the shipped default config, with the same semantics as an include entry's `patches` (the committed Code Mode overlay is the template): an id-targeted patch replaces the named entry's whole `config` (restate unchanged fields), `insert` adds entries, and `!!js` expressions interpolate at mount — so a personal `apiKey` can reference the personal `.env`. A patch naming an entry id absent from the booted tree is skipped with a loader warning. An empty or comments-only file throws (it parses to nothing, not to a list); disable the overlay with `[]` or by deleting the file.

Subprocess test launchers point `DSH_HOME` at an isolated per-test directory so a developer's personal overlay can never leak into fixtures.

## Model Experience

Indirectly, through the plugin tree it loads, which determines the prompts, schemas, messages, and model adapter in the resulting application; the one export that contributes model-visible text, `addHarnessSourceSection`, does so only when a consumer calls it after boot.

#### KV Cache effect

No direct invalidation from `boot()`; a consumer that calls `addHarnessSourceSection` places one short line near the system prompt's head, before per-request content, so it does not invalidate the cache across turns, and any other request-prefix change is owned by the named consumer.

## Known Limitations and Deferred Work

- **Bare package specifiers depend on Loader internals** — production bins need Loader's optional native helper; an in-process caller without it must use resolvable relative/file specifiers or tsx path mapping.
- **Snapshot replay swapping is basename-specific** — only a config ending in `cordis.yml` or `cordis.yaml` maps to the sibling `cordis.snapshot.yml`; custom config names require caller-managed selection.
- **Environment loading is cwd-scoped and optional** — the helper loads one `.env` file and warns on failure; it does not search parents, merge profiles, or validate required variables.
- **Personal config is patch-shaped** — an id-targeted patch replaces the entry's whole `config` rather than deep-merging, so a personal override restates the base fields it keeps.
- **Personal patches see only the booted file's own entries** — an overlay leaf that reaches its base through a nested include entry (the Code Mode configs) resolves personal patch ids against the overlay's top-level entries, not the included subtree.
