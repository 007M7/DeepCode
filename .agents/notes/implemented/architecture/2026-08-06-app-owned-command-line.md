# Agent Note: Apps own their command line through `ctx.cmdlineArgs`

Status: implemented

English | [中文](2026-08-06-app-owned-command-line.zh.md)

## Problem

After profiles, compositions were installable but their command lines were not. `apps/cli` still declared the Web flag family (`--host`, `--port`, `--dev`, `--workspace-root`, `--trusted-host`) and the one-shot task positional, then derived patches for row ids it hardcoded (`webserver`, `api-gateway`, `connection`, `web-runtime`). An out-of-tree app such as [turtle-ui](https://github.com/deepseek-harness/turtle-ui) could contribute rows but had no way to accept a flag: `dsh --profile tui --resume <session>` had nowhere to be parsed, and `dsh --profile web --help` printed the launcher's help rather than the web app's.

## Decision

The launcher parses only what it owns — `--profile`, `--patch`, the config dumps — and hands **everything after its own flags** to the booted tree verbatim. The split is positional: the first token the launcher does not recognize starts the app's arguments (commander's `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`). A bare `dsh -h`, which has no app to hand the flag to, still prints the launcher's own help.

The new `@deepseek-ai/dsh-cmdline` package owns the handoff. A launcher calls `provideCmdline(ctx, host)` before any entry mounts, providing `ctx.cmdlineArgs` (whose whole interface is `get(): readonly string[]`) and `ctx.appExit`. An app consumes them from its **startup row**. Both the Loader row and plugin inject `cmdlineArgs`; the plugin calls `runStartup(ctx, service, program, plan)` with its own commander program and provides what it resolved as its own service. The Loader-row injection is also the launcher's discovery declaration; there is no parallel bundle-manifest field. Before boot, the launcher rejects nonempty app arguments with no active declaration and any composition with multiple active declarations. The rows the app configures inject that service and read it from their own config expressions (`port: !!js ctx.webStartup.port ?? 3080`), so a flag beats the value written beside it and nothing is written back into any row.

The boot mounts the composition once. Cordis holds each row until its injections are active; Loader then interpolates that row's `!!js` against the injection-ready plugin context immediately before activation. Include keeps nested row expressions raw until their target row reaches this point. `--help` provides no startup service, so dependent rows never activate, and a live patch reload interpolates again against the service that remains active, so a served port cannot be silently reset.

The shipped apps moved their flags into their bundles: `dsh-web-app` owns the Web family (and enables the `client-hmr` row it now ships disabled, for `--dev`), and `dsh-headless` owns the task positional and rejects a missing task as a usage error. `apps/cli/src/web.ts` is gone; `runProfile` no longer knows any flag-target row id. Out of tree, turtle-ui gained `--resume <session>` / `--session <id>` the same way, which is the design's real validation: an installed plugin added a flag with no launcher change.

Two further consequences. Loader mounts sibling rows concurrently, so one row can activate while another still mounts or while the whole boot is rolling back; the Web bundle therefore publishes its URL only after its own Loader tree settles. The Web bundle's runtime plugin owns the harness-source prompt section too, so `dsh web` and `dsh --profile web` boot identically without Web-specific launcher setup.

## Why Loader owns the ordering

Four framework facts shape the mechanism:

- **A profile's rows arrive inside the root include's `patches` option.** Include is an entry-tree owner, so its static entry-config resolver interpolates Include's own options while preserving nested `!!js` nodes for their target rows instead of recursively evaluating them in the Include context.
- **Cordis activates a fiber only after all declared injections are active.** Immediately before each activation, Cordis runs the `internal/config` waterfall against the fiber's own context; Loader's listener interpolates the raw config after Cordis snapshots its injected services.
- **Provider replacement and HMR must preserve the same contract.** Fiber reactivation re-runs the waterfall, HMR carries the raw config to the replacement fiber, and a pending row accepts option changes without prematurely evaluating expressions against absent services.
- **A row cannot be inserted from inside a mounting plugin** — `tree.create` returns a prefixed id it then fails to resolve — so a conditional row ships `disabled: true` and an active row enables it (`dsh web --dev` and its reload chain). Enablement is an in-memory Loader override rather than an options rewrite, so Include reapplication cannot silently disable it. The Web bundle also starts client discovery only after enabling the optional row, ensuring the first browser graph already contains its HMR receiver.

This leaves dependency ordering in Cordis activation and Loader interpolation, which own it. Rows keep their `inject` and config, Loader mounts the composition once, and the launcher only provides argv and process-lifecycle services.

## Alternatives considered

- **Writing the resolved values into each row** (a config update per row, plus a patch layer handed back to the launcher so a reload could not undo it): it worked, but it meant patches travelling from an app to the launcher and back, two mechanisms for one fact, and a recycle whose correctness depended on Loader restart internals. The maintainer rejected the round trip; the service the rows read replaced all of it.
- **Releasing rows by clearing their `inject`**: it worked in isolation and failed on the real web tree, because clearing `inject` is exactly what loses the plugin's static injections. The failure is silent until a plugin reads a service it declared.
- **Launcher-managed two-pass mounting**: it can make a provider active before readers are applied, but duplicates the composition, makes ordering a launcher concern, and conceals the Loader defect that nested expressions were evaluated in the include context rather than the target row's injected context.
- **The launcher running each bundle's startup function before boot** (no cordis involvement): strictly earlier than "boot, then help", but it makes app startup a second plugin protocol outside the tree. Using a `cmdlineArgs`-injected startup row keeps one protocol: it is an ordinary row, dumpable and patchable, and a layering bundle disables it like any other.
- **Both apps parsing the same argv** (a custom composition combines Web and one-shot startup rows): two parsers cannot both own `-h`. A composition has exactly one command-line owner, so a layering bundle disables the startup row it absorbs and provides every startup service its retained rows inject.
- **`instanceof CommanderError`**: an out-of-tree plugin brings its own commander copy, so the class identity differs and a printed `--help` was rethrown as a fatal load failure. Commander's control-flow errors are detected structurally instead.

## Consequences

- An app's flags, help text, and usage errors live with the rows they configure; adding a flag to an installed plugin needs no launcher change.
- The launcher still recognizes the headless runner for one-shot process lifetime and the telemetry row for its environment switch; neither path interprets app arguments.
- `--help` leaves every row that depends on a startup service pending and requests bounded exit; unrelated rows may activate concurrently before teardown. A profile with no active row injecting `cmdlineArgs` rejects nonempty app arguments before mounting instead of ignoring them.
- A startup service has no statically declared owner: a bundle shipping reading rows without its startup row fails at settlement with pending entries naming the service, not at load.
- A user patch that replaces a row's whole `config` drops its expressions, and with them the flag's precedence for that row.
- Launcher flags must precede app arguments; a first app argument equal to `web` or `plugin` selects that subcommand instead, `-V`/`--version` remains launcher-owned before that boundary, and the launcher's parser consumes one `--`, so a literal `--` for the app needs `-- --`.
- `--dump-config` never runs a startup row, so it prints the composition before any app argument is resolved and rejects an invocation that carries app arguments.
