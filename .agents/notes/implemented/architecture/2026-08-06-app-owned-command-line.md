# Agent Note: Apps own their command line through `ctx.cmdlineArgs`

Status: implemented

English | [中文](2026-08-06-app-owned-command-line.zh.md)

## Problem

After profiles, compositions were installable but their command lines were not. `apps/cli` still declared the Web flag family (`--host`, `--port`, `--dev`, `--workspace-root`, `--trusted-host`) and the one-shot task positional, then derived patches for row ids it hardcoded (`webserver`, `api-gateway`, `connection`, `web-runtime`). An out-of-tree app such as [turtle-ui](https://github.com/deepseek-harness/turtle-ui) could contribute rows but had no way to accept a flag: `dsh --profile tui --resume <session>` had nowhere to be parsed, and `dsh --profile web --help` printed the launcher's help rather than the web app's.

## Decision

The launcher parses only what it owns — `--profile`, `--patch`, the config dumps — and hands **everything after its own flags** to the booted tree verbatim. The split is positional: the first token the launcher does not recognize starts the app's arguments (commander's `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`). A bare `dsh -h`, which has no app to hand the flag to, still prints the launcher's own help.

The new `@deepseek-ai/dsh-cmdline` package owns the handoff. A launcher calls `provideCmdline(ctx, host)` before any entry mounts, providing `ctx.cmdlineArgs` (whose whole interface is `get(): readonly string[]`), `ctx.appExit`, and `ctx.appPatches`. An app consumes them from a **startup row** that injects `cmdlineArgs` and calls `runStartup(ctx, service, program, plan)` with its own commander program; rows the app configures inject that startup service in the bundle patch, so they cannot start before their values are resolved, and `--help` prints, disables those rows, and exits without the app ever starting.

The shipped apps moved their flags into their bundles: `dsh-web-app` owns the Web family (and enables the `client-hmr` row it now ships disabled, for `--dev`), and `dsh-headless` owns the task positional and rejects a missing task as a usage error. `apps/cli/src/web.ts` is gone; `runProfile` no longer knows any row id. Out of tree, turtle-ui gained `--resume <session>` / `--session <id>` the same way, which is the design's real validation: an installed plugin added a flag with no launcher change.

Two further consequences fell out of review. An app's decisions are also handed back to the launcher as patches (`ctx.appPatches`), because the launcher re-applies its whole patch stack when a user edits a live patch file: without that layer, an unrelated edit rebuilt every row from its composed options and silently moved a server started on `--port 8080` back to the composed port, dropping `--dev` and the derived `/api` fence authorities with it. And `dsh --profile web` now adds the harness-source prompt section that only the `dsh web` alias used to add — the two paths finally boot identically, which also means a user profile named `web` inherits it.

## How a waiting row actually receives its values

Three vendored-Loader facts shaped the mechanism, all found by probe:

- **A row's config is resolved when the Loader creates its fiber, which happens while the row is still waiting for its startup service.** Writing a new config onto that waiting fiber never reaches the plugin. Each changed row is therefore recycled — disabled, then re-enabled with its new values — which drops the stale fiber and resolves the config again.
- **Updating a row's `inject` loses the plugin's own static injections.** The Loader restarts a replaced row from `runtime.callback`, the unwrapped function, and `Inject.resolve(plugin.inject)` then finds nothing: a row declaring `inject = ['httpServer', 'apiProxy']` comes back unable to read either. Recycling therefore never touches `inject`; the waiting rows are released by providing the service.
- **A row's config is validated at fiber creation too**, so a row whose *required* config the startup supplies (the one-shot runner's `task`) must ship `disabled: true`; making it wait is not enough, because the boot fails before the startup row can run. It only appeared to work because the startup module happened to import first.

A related constraint: a row cannot be inserted from inside a mounting plugin (`tree.create` returns a prefixed id it then fails to resolve), so a conditional row ships `disabled: true` and startup enables it. Recycling also lets a still-in-flight mount settle first, since disabling alone is not a barrier.

## Alternatives considered

- **Releasing the rows by clearing their `inject`** (one atomic update per row): it worked in isolation and failed on the real web tree, because clearing `inject` is exactly what loses the plugin's static injections. The failure is silent until a plugin reads a service it declared.
- **Reading flags from the row's config through `!!js ctx.get('webStartup')`**: config expressions are interpolated when the fiber is created, before the startup service exists, so every waiting row would read `undefined`.
- **The launcher running each bundle's startup function before boot** (no cordis involvement): simplest and strictly earlier than "boot, then help", but it makes app startup a second plugin protocol outside the tree. The maintainer's ruling was a startup *service* other rows depend on, which keeps one protocol.
- **Both apps parsing the same argv** (the one-shot bundle rides over the web bundle): two parsers cannot both own `-h`. A composition has exactly one command-line owner: the layering bundle disables the underlying startup row and names both startup services, so the absorbed rows start on their composed values.
- **`instanceof CommanderError`**: an out-of-tree plugin brings its own commander copy, so the class identity differs and a printed `--help` was rethrown as a fatal load failure. Commander's control-flow errors are detected structurally instead.

## Consequences

- An app's flags, help text, and usage errors live with the rows they configure; adding a flag to an installed plugin needs no launcher change.
- `--help` cost is a boot: the tree mounts far enough for the startup row to run, then tears down. The rows waiting on that app never start, which is what the maintainer accepted when choosing the service-shaped design.
- A startup service has no statically declared owner: a bundle shipping waiting rows without its startup row fails at settlement with pending entries naming the service, not at load.
- Launcher flags must precede app arguments; a first app argument reading `web` or `plugin` selects those subcommands instead, and the launcher's parser consumes one `--`, so a literal `--` for the app needs `-- --`.
- `--dump-config` never runs a startup row, so it prints the composition before any app argument is resolved and rejects an invocation that carries app arguments.
