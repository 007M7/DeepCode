# Agent Note: Parse `dsh` argv through one Commander adapter

Status: implemented

English | [中文](2026-07-24-dsh-commander-argument-adapter.zh.md)

## Problem

The `dsh` CLI entry (`apps/cli`) parsed argv in three hand-rolled idioms that did not compose and gave no `--help`/`--version`. `bin.ts` dispatched by raw inspection — `argv[0] === 'web'`, then `argv.includes('-p') || argv.includes('--prompt')`, else TUI — which is positional-blind: a prompt flag or a config path in the wrong position could misroute the mode, and `argv.includes('-p')` could not tell a real flag from an incidental token. `headless.ts` and `web.ts` each ran their own `node:util` `parseArgs` with inline host/port validation, and `dsh-app-boot` carried `parseResumeArg`, a ~30-line bespoke scanner reimplementing flag/`=`-form/value/repeat handling for `--resume`. Usage was a single hardcoded `usage: dsh -p "task"` line; there was no version flag and no rendered help.

## Decision

Argv is parsed once, in `apps/cli/src/args.ts`, through a Commander adapter (the same parser the SDK bins — `create-sdk`, `dsh-scripts` — already standardize on). `parseDshArgs(argv, version)` resolves the invocation into a discriminated `DshInvocation` union: `{ mode: 'tui', config?, resume? }`, `{ mode: 'headless', prompt }`, `{ mode: 'web', host, port }`, `{ mode: 'help' | 'version', text }`, or `{ mode: 'error', message }`. Commander runs under `exitOverride()` with output captured, so it never writes or exits on its own — `--help`, `--version`, and every parse error come back as data.

`bin.ts` calls the adapter once and switches on `mode` (closed union, `satisfies never` default), dynamic-importing only the chosen mode's module. Each mode module now consumes already-parsed values: `runTui(config, resume)`, `runHeadless(task)`, `runWeb(host, port)` — none re-reads argv. `web` is a **reserved first token**: `parseDshArgs` dispatches a leading `web` to its own Commander parser and everything else to the default TUI/headless parser, so root flags and `web` flags never share a grammar — `dsh web -p x` fails loud (`web` has no `-p`) and `dsh -p x web` is just a headless prompt whose second positional is dropped, with no cross-command leakage to guard against. Each parser reads Commander's `opts()`/`processedArgs` after `parse()` rather than through action closures. `--host` is a `.choices([LOOPBACK_HOST, ALL_INTERFACES_HOST])` and `--port` an `argParser` that range-checks 0–65535, moving both from the inline `runWeb` checks into the parser. Two post-parse checks preserve the "never silently start fresh" invariant: an empty `--resume=` id and an empty `-p` task each become a `mode: 'error'`, because agent-loop treats an empty resume id as no-resume and an empty prompt has nothing to run. A repeated `--resume` is Commander's natural last-wins (the old bespoke scanner rejected it; last-wins is the standard CLI behavior and needs no special case). `--version` reads this app's `package.json`.

`parseResumeArg` is deleted from `dsh-app-boot` (its export, its README row, and its unit block); the pre-release stance permits the removal. `dsh-app-boot` keeps its boot/env/config/personal-overlay helpers — only the argv scanner leaves.

## Package topology

The argument surface stays inside `apps/cli`, the assembly tier, not a `packages/*` library: it is this one app's routing, not a reusable seam. `dsh-app-boot` shrinks to boot glue with no CLI-parsing responsibility. `commander@^15` is added to `apps/cli/package.json`, matching the SDK bins' pin.

## Alternatives considered

**Keep `node:util` `parseArgs` and only unify the dispatch** — rejected: `parseArgs` has no subcommand model, no rendered help, and no version flag, so `web` routing and `--help`/`--version` would stay hand-rolled. The repo already chose Commander for its other CLIs; a second parser idiom for `dsh` alone is the fragmentation this change removes.

**Keep `parseResumeArg` as a shared helper and feed it Commander's residual args** — rejected: the whole point is to retire the bespoke scanner. Commander parses `--resume` (space and `=` forms, missing-value, position-independence) natively; keeping a parallel hand-written path for the one flag would preserve the duplication the change exists to end.

**Make `web` a Commander subcommand of one root program** — rejected: a single program mixing a root `-p`/`--resume` grammar with a `web` subcommand leaks the root options onto `web` unless `enablePositionalOptions()` plus a parent-option guard are bolted on, which is exactly the kind of special-case machinery this change removes. Dispatching `web` as a reserved first token to a second parser is smaller and keeps the two grammars fully independent.

**Make the argument surface a `packages/*` seam** — rejected: nothing outside `dsh` consumes it, and capability seams are not split preemptively. The Commander adapter is `apps/cli`'s own concern.

## Testing

`apps/cli/tests/args.spec.ts` (new; `apps/*/tests` added to the vitest include and `apps/cli/tests` to `tsconfig.host.json`) covers the adapter at the level that matters: mode routing by shape, the fail-loud checks (empty resume/prompt, bad host/port, unknown option), and `--help`/`--version` surfacing as data. The `dsh CLI keyless smoke` group in `examples/tui-agent/tests/tui-keyless-smoke.e2e.ts` exercises the real `bin.ts` dispatch end to end through a PTY (default boot, personal overlay, invalid config, `--resume` failure, source-path prompt) and stays green unchanged. `packages/ui/app-boot/tests/app-boot.spec.ts` drops its `parseResumeArg` block.

## Consequences

`dsh` gains rendered `--help`/`--version` and consistent fail-loud parse errors, and mode routing no longer depends on flag position. Argv parsing lives in one place with one parser idiom shared with the SDK bins, at the cost of a `commander` dependency on `apps/cli` and Commander's parse semantics (its error strings, its `exitOverride` contract) now sitting on the CLI's front door. `dsh-app-boot` no longer owns any CLI-parsing surface; a future consumer needing `--resume`-style parsing composes Commander rather than reviving the deleted scanner.
