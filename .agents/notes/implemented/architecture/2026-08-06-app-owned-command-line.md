# Agent Note: Apps own their command line through `ctx.cmdlineArgs`

Status: implemented

English | [中文](2026-08-06-app-owned-command-line.zh.md)

## Problem

After profiles, compositions were installable but their command lines were not. `apps/cli` still declared the Web flag family (`--host`, `--port`, `--dev`, `--workspace-root`, `--trusted-host`) and the one-shot task positional, then derived patches for row ids it hardcoded (`webserver`, `api-gateway`, `connection`, `web-runtime`). An out-of-tree app such as [turtle-ui](https://github.com/deepseek-harness/turtle-ui) could contribute rows but had no way to accept a flag: `dsh --profile tui --resume <session>` had nowhere to be parsed, and `dsh --profile web --help` printed the launcher's help rather than the web app's.

## Decision

The launcher parses only what it owns — `--profile`, `--patch`, the config dumps — and hands **everything after its own flags** to the booted tree verbatim. The split is positional: the first token the launcher does not recognize starts the app's arguments (commander's `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`). A bare `dsh -h`, which has no app to hand the flag to, still prints the launcher's own help.

The new `@deepseek-ai/dsh-cmdline` package owns the handoff. A launcher calls `provideCmdline(ctx, host)` before any entry mounts, providing `ctx.cmdlineArgs` (whose whole interface is `get(): readonly string[]`), `ctx.appExit`, and `ctx.appReady`. An app consumes them from its **entrypoint row** — named by its bundle manifest (`dsh.bundle.entrypoint`) — which injects `cmdlineArgs` and calls `runStartup(ctx, service, program, plan)` with its own commander program, then provides what it resolved as its own service. The rows the app configures read that service from their own config expressions (`port: !!js ctx.get('webStartup')?.port ?? 3080`), so a flag beats the value written beside it and nothing is written back into any row.

The boot mounts in two passes, which is what the manifest declaration buys: entrypoints alone, then the whole composition. A row's config expressions are evaluated when the include applies the row, and a strict `ctx.get` only answers for a service whose providing fiber is active, so the rest of the tree has to be applied after the entrypoints are up. `--help` therefore exits before the second pass exists, and a user editing a live patch file re-applies that pass against services that are still up, so a served port cannot be silently reset.

The shipped apps moved their flags into their bundles: `dsh-web-app` owns the Web family (and enables the `client-hmr` row it now ships disabled, for `--dev`), and `dsh-headless` owns the task positional and rejects a missing task as a usage error. `apps/cli/src/web.ts` is gone; `runProfile` no longer knows any row id. Out of tree, turtle-ui gained `--resume <session>` / `--session <id>` the same way, which is the design's real validation: an installed plugin added a flag with no launcher change.

Two further consequences. Loader settlement stopped meaning "the app is up" — a row mounted in the second pass can observe a settled tree while the pass that mounted it is still going, or already rolling back — so a row that publishes readiness (the web URL line) awaits `ctx.appReady` instead. And `dsh --profile web` now adds the harness-source prompt section that only the `dsh web` alias used to add: the two paths finally boot identically, which also means a user profile named `web` inherits it.

## Why the boot has phases

Four vendored-Loader facts shaped the mechanism, all found by probe:

- **A profile's rows arrive as the root include's `patches` option, and an entry's whole config is interpolated when that entry starts.** Every `!!js` in every row is therefore evaluated once, when the include mounts — before any row exists. Rows in the root config *file* would interpolate per row, but a profile root is empty by design.
- **A strict `ctx.get` hides a service whose providing fiber is not yet ACTIVE**, and a plugin's own fiber is not active while its `apply` is still running. Providing a service and configuring rows from it in the same pass cannot work.
- **Updating a row's `inject` loses the plugin's own static injections.** The Loader restarts a replaced row from `runtime.callback`, the unwrapped function, and `Inject.resolve(plugin.inject)` then finds nothing: a row declaring `inject = ['httpServer', 'apiProxy']` comes back unable to read either.
- **A row cannot be inserted from inside a mounting plugin** — `tree.create` returns a prefixed id it then fails to resolve — so a conditional row ships `disabled: true` and a row that mounts beside it enables it (`dsh web --dev` and its reload chain).

Together these rule out configuring rows from a service in one pass, and rule in the phased mount: rows keep their own `inject` and their own config, and the only thing the launcher does between phases is apply the composition again.

## Alternatives considered

- **Writing the resolved values into each row** (a config update per row, plus a patch layer handed back to the launcher so a reload could not undo it): it worked, but it meant patches travelling from an app to the launcher and back, two mechanisms for one fact, and a recycle whose correctness depended on Loader restart internals. The maintainer rejected the round trip; the service the rows read replaced all of it.
- **Releasing rows by clearing their `inject`**: it worked in isolation and failed on the real web tree, because clearing `inject` is exactly what loses the plugin's static injections. The failure is silent until a plugin reads a service it declared.
- **Rows waiting on the service in a single-pass mount**: the config expressions are interpolated before any row exists, so every reader would see `undefined`.
- **The launcher running each bundle's startup function before boot** (no cordis involvement): strictly earlier than "boot, then help", but it makes app startup a second plugin protocol outside the tree. Declaring an entrypoint *row* keeps one protocol: the entrypoint is an ordinary row, dumpable and patchable, and a layering bundle disables it like any other.
- **Both apps parsing the same argv** (the one-shot bundle rides over the web bundle): two parsers cannot both own `-h`. A composition has exactly one command-line owner: the layering bundle disables the underlying startup row and names both startup services, so the absorbed rows start on their composed values.
- **`instanceof CommanderError`**: an out-of-tree plugin brings its own commander copy, so the class identity differs and a printed `--help` was rethrown as a fatal load failure. Commander's control-flow errors are detected structurally instead.

## Consequences

- An app's flags, help text, and usage errors live with the rows they configure; adding a flag to an installed plugin needs no launcher change.
- `--help` mounts only the entrypoints and exits, so nothing else in the composition ever starts.
- A startup service has no statically declared owner: a bundle shipping reading rows without its entrypoint fails at settlement with pending entries naming the service, not at load.
- A user patch that replaces a row's whole `config` drops its expressions, and with them the flag's precedence for that row.
- Launcher flags must precede app arguments; a first app argument reading `web` or `plugin` selects those subcommands instead, and the launcher's parser consumes one `--`, so a literal `--` for the app needs `-- --`.
- `--dump-config` never runs a startup row, so it prints the composition before any app argument is resolved and rejects an invocation that carries app arguments.
