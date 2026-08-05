# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

The `dsh` command has three entry modes: a required raw config overlay, a one-shot headless prompt, and the Web UI. [`src/args.ts`](src/args.ts) owns the Commander grammar, and [`src/bin.ts`](src/bin.ts) dynamically imports only the selected runner. Unknown commands and leaked options fail with a nonzero exit code.

## Raw config

Raw `dsh` requires an explicit patch-list config:

```sh
dsh --config ./app.cordis.yml
```

The named file is applied directly over [`config/base.cordis.yml`](config/base.cordis.yml) through the Include plugin's patch algorithm. It is not a complete replacement tree, and neither the personal `$DSH_HOME/config.yaml` nor another surface overlay is added. The base deliberately contains no startup agent or interaction front door; the required overlay selects those deployment details. Relative config paths resolve from the invoking directory. A parse, schema, resolution, or plugin boot failure is reported and exits nonzero. SIGINT and SIGTERM dispose the mounted root before exit.

A patch targets a base row by `id` and replaces that row's complete `config` value rather than deep-merging keys. Patch lists may also insert new rows whose plugin modules the shipped Loader can resolve:

```yaml
- id: agent-loop
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
```

Inspect the effective tree without booting it:

```sh
dsh --dump-default-config
dsh --config ./app.cordis.yml --dump-config
```

`--dump-default-config` prints only the shipped base. `--dump-config` requires `--config` and prints base plus overlay with provenance comments. Composition uses `applyEntryPatches` and `entryListSchema` from `@cordisjs/plugin-include`; `!!js` expressions remain unevaluated, and unmatched patch targets are reported on stderr.

## Web and headless

`dsh web` boots `base.cordis.yml` plus [`config/web.cordis.yml`](config/web.cordis.yml), followed by `$DSH_HOME/config.yaml` when present. `dsh web --config <path>` replaces that personal layer with the explicit patch list. `--host`, `--port`, `--workspace-root`, and repeatable `--trusted-host` values become Web host patches; their owning plugin schemas validate them at boot. `--dev` mounts the client-plugin HMR receiver and expects a separate `pnpm run dev:web` watcher for no-refresh client bundle updates.

```sh
dsh web
dsh web --config ./web-profile.cordis.yml
dsh web --dump-default-config
dsh web --dump-config
```

The production Web runner needs built package and frontend artifacts (`pnpm run build`). It serves `http://127.0.0.1:3080` by default. Binding all interfaces also trusts the machine's discovered LAN IP literals; `--trusted-host` adds named authorities accepted by the `/api` browser-trust fence.

`dsh -p "task"` uses the same base and Web composition with the startup personal config, starts its Web host on an OS-assigned port, runs one fresh persisted session, prints the final answer, and exits. It accepts neither `--config` nor raw config-dump flags.

Web and headless process shutdown gives the plugin tree up to five seconds to dispose. The first `SIGINT`/`SIGTERM` starts that graceful drain; a second signal forces immediate exit. If headless normal completion is already stuck in disposal, the first `Ctrl+C` is the escalation and exits immediately instead of being swallowed.

Both modes treat the invoking directory as the default workspace root, load applicable `AGENTS.md` or `CLAUDE.md` instructions with a 65,536-byte render budget, and use an in-memory SQLite session content index. Web watches valid personal config edits; headless reads the file once at startup. The [app-boot personal-config contract](../../packages/ui/app-boot/README.md#personal-config) owns layer precedence, credential storage, live-update failure behavior, and `$DSH_HOME` resolution.

New sessions default to the `workspace-write` permission preset. Bash and filesystem mutations are restricted to the session workspace and platform temporary roots; reads, network access, and process visibility are not confined. `DSH_PERMISSION_MODE` changes the process fallback. Stored General-settings permissions affect later Web sessions, not an already-open one.

`DSH_TOOLS_MODE` selects `native`, `code`, or `both` for the Web/headless process; another value fails at boot. [`config/core-web.cordis.yml`](config/core-web.cordis.yml) is an optional Web overlay that reduces the native model surface to persistent `bash` and `str_replace_editor` while retaining the shipped host, browser, workspace, persistence, and permission composition.

## Shared deployment behavior

The base mounts the native DeepSeek adapter, settings and credential providers, stable `web_search`, repository Plugin support, and session telemetry. Provider credentials live in `$DSH_HOME/.env` or the ambient environment and remain rotatable because the launcher never hoists the credential file into `process.env`. Search uses `DEEPSEEK_API_KEY` and accepts `DEEPSEEK_SEARCH_BASE_URL`; `web_fetch` is disabled unless an overlay inserts a provider and enables it.

Session events stream as OTLP/HTTP logs by default. `DSH_TELEMETRY_OTLP_URL` selects another collector. Any non-empty `DSH_TELEMETRY_DISABLED` disables the telemetry row before boot. The shipped base has no telemetry redaction rule, so exported records can contain message text, tool arguments and results, and workspace paths; the [telemetry Agent Note](../../.agents/notes/implemented/feature/2026-07-31-web-telemetry-default-mount.md) owns that deployment decision.

The empty `repository-plugins` row lets Web/headless personal config and raw overlays mount prepared immutable repository Plugin generations. See the [repository Plugin contract](../../packages/cordis/repository-plugin/README.md#standalone-app-configuration). The CLI also ships `@deepseek-ai/dsh-mcp-client` as a dependency for overlays, but no MCP server is enabled by default because each server command is trusted executable code outside the agent sandbox.

## Source launcher

Link the source-running launcher onto PATH:

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

It resolves the checkout through its real path and launches `apps/cli/src/bin.ts` with `node --import tsx/esm`. `TSX_TSCONFIG_PATH` is pinned to the checkout root, so workspace package resolution is independent of the invoking directory. `pnpm run dsh` uses the same entry and forwards arguments. The built form is `apps/cli/lib/bin.js` after `pnpm run build`.
