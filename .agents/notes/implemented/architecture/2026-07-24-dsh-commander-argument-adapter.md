# Agent Note: Parse `dsh` argv through one Commander adapter

Status: implemented

English | [中文](2026-07-24-dsh-commander-argument-adapter.zh.md)

## Problem

The `dsh` CLI entry (`apps/cli`) parsed argv in three hand-rolled idioms that did not compose and gave no `--help`/`--version`. `bin.ts` dispatched by raw inspection — `argv[0] === 'web'`, then `argv.includes('-p') || argv.includes('--prompt')`, else TUI — which is positional-blind: a prompt flag or a config path in the wrong position could misroute the mode, and `argv.includes('-p')` could not tell a real flag from an incidental token. `headless.ts` and `web.ts` each ran their own `node:util` `parseArgs` with inline host/port validation, and `dsh-app-boot` carried `parseResumeArg`, a ~30-line bespoke scanner reimplementing flag/`=`-form/value/repeat handling for `--resume`. Usage was a single hardcoded `usage: dsh -p "task"` line; there was no version flag and no rendered help.

## Decision

Argv is parsed once, in `apps/cli/src/args.ts`, through a Commander adapter (the same parser the SDK bins — `create-sdk`, `dsh-scripts` — already standardize on). `parseDshArgs(argv, version)` returns a discriminated `DshInvocation` union of the three real modes: `{ mode: 'tui', config?, resume? }`, `{ mode: 'headless', prompt }`, or `{ mode: 'web', host, port, dev }`. It does **not** model help/version/errors as data: Commander owns those, printing usage or the diagnostic and exiting at the point of failure. `exitOverride()` turns each into a thrown `CommanderError` carrying the intended code (0 for help/version, 1 for a parse or domain error), which one `try/catch` in `parseDshArgs` turns into `process.exit`.

`bin.ts` calls the adapter once and switches on `mode` (closed union, `satisfies never` default), dynamic-importing only the chosen mode's module; only a valid, non-help invocation reaches the switch, so it has no help/version/error cases. Each mode module consumes already-parsed values: `runTui(config, resume)`, `runHeadless(task)`, `runWeb(host, port, dev)` — none re-reads argv. `web` is a **reserved first token**: `parseDshArgs` dispatches a leading `web` to its own Commander parser and everything else to the default TUI/headless parser, so root flags and `web` flags never share a grammar — `dsh web -p x` fails loud (`web` has no `-p`). Each parser reads Commander's `opts()`/`processedArgs` after `parse()`, then bails via `command.error(...)` (print + exit 1) on the domain checks Commander cannot express: `--prompt` selects headless and rejects an empty task or a stray config/`--resume` rather than silently dropping a TUI input; an empty `--resume=` id fails loud (agent-loop treats `''` as no-resume); `--host` must be loopback/all-interfaces and `--port` an integer in 0–65535, moving both from the inline `runWeb` checks into the parser. `--dev` mounts the client HMR driver and bundle watch. A repeated `--resume`, or a following flag captured as a `--resume`/`--prompt` value, is Commander's standard behavior (last-wins / next-token) and is left alone; a bad id fails loud downstream when the session cannot load. `dsh --help` discloses the `web` mode through an `addHelpText` line (a real `web` subcommand would hijack the `[config]` positional). `--version` reads this app's `package.json`.

`parseResumeArg` is deleted from `dsh-app-boot` (its export, its README row, and its unit block); the pre-release stance permits the removal. `dsh-app-boot` keeps its boot/env/config/personal-overlay helpers — only the argv scanner leaves.

## Resume without an environment variable

Merging the concurrent safe-session-resume feature onto this parser retired the `RESUME_SESSION_ID` environment variable, which had been the only bridge from `--resume` into the shipped config's `resumeSessionId: !!js process.env.RESUME_SESSION_ID`. `runTui` now injects the already-parsed id through `boot`'s `prepare(ctx)` hook — `ctx.provide(RESUME_SESSION_ID_KEY, id)` (a new `dsh-app-boot` export, value `'resumeSessionId'`) — and the four tui-agent/cordis configs read it as a bare identifier: `resumeSessionId: !!js "typeof resumeSessionId === 'string' ? resumeSessionId : undefined"`. The expression is quoted because YAML otherwise parses the `?`/`:` as a mapping; the `typeof` guard tolerates a launcher that never provides the slot. The `/resume` in-place handoff (`process.execve`) rebuilds its re-exec argv directly from the parsed values as `dsh --resume=<id> [-- <config>]` — the `--` keeps a config named `web` or starting with `-` a positional — so `replaceResumeArg` (which the merge brought in) is dropped alongside `parseResumeArg`.

## One terminal front door: `dsh`

The `dsh-tui-demo` package was a plugin (the TUI app bundle mounted by `dsh`'s config) plus a redundant `bin` that booted a leaf `cordis.yml` — the same job `dsh [config]` does. The bin is removed: `demo:cordis`, `demo:code-mode`, and both the tui-agent and cordis-agent keyless PTY smokes now launch through `apps/cli/src/bin.ts` with the config as the positional argument, and the package keeps only its plugin and invariant entries. The peer/dev `dsh-app-boot` dependency, the `bin`/`./bin` export, the demo's `built-bin.e2e.ts`, and the tsdown `bin` entry all leave with it. `dsh`'s own TTY guard (refuse piped stdio before booting, pointing at `dsh -p` for automation) gains a matching `apps/cli/tests/built-bin.e2e.ts` that runs the built `lib/bin.js` under plain Node with piped stdio (`apps/*/tests` added to the e2e vitest include). `cli-demo`, `acp-demo`, and `jsonrpc-demo` keep their bins because each is a distinct surface (headless, ACP, JSON-RPC) `dsh` does not provide.

## Package topology

The argument surface stays inside `apps/cli`, the assembly tier, not a `packages/*` library: it is this one app's routing, not a reusable seam. `dsh-app-boot` shrinks to boot glue with no CLI-parsing responsibility. `commander@^15` is added to `apps/cli/package.json`, matching the SDK bins' pin.

## Alternatives considered

**Keep `node:util` `parseArgs` and only unify the dispatch** — rejected: `parseArgs` has no subcommand model, no rendered help, and no version flag, so `web` routing and `--help`/`--version` would stay hand-rolled. The repo already chose Commander for its other CLIs; a second parser idiom for `dsh` alone is the fragmentation this change removes.

**Keep `parseResumeArg` as a shared helper and feed it Commander's residual args** — rejected: the whole point is to retire the bespoke scanner. Commander parses `--resume` (space and `=` forms, missing-value, position-independence) natively; keeping a parallel hand-written path for the one flag would preserve the duplication the change exists to end.

**Make `web` a Commander subcommand of one root program** — rejected: a single program mixing a root `-p`/`--resume` grammar with a `web` subcommand leaks the root options onto `web` unless `enablePositionalOptions()` plus a parent-option guard are bolted on, which is exactly the kind of special-case machinery this change removes. Dispatching `web` as a reserved first token to a second parser is smaller and keeps the two grammars fully independent.

**Make the argument surface a `packages/*` seam** — rejected: nothing outside `dsh` consumes it, and capability seams are not split preemptively. The Commander adapter is `apps/cli`'s own concern.

**Keep `RESUME_SESSION_ID` as the resume bridge** — rejected: with `--resume` parsed into a value the bin already holds, threading it through an environment variable the config re-reads is indirection with no benefit, and it left the demo bin a second, env-only resume path. Providing the id on the boot context is the same channel `boot`'s `prepare` hook already uses for `tuiResumeHost`.

**Keep the `dsh-tui-demo` bin** — rejected: it duplicated `dsh [config]` exactly, and keeping it forced the demo-only `RESUME_SESSION_ID` fallback to stay alive. Its plugin is what the configs actually mount; only the front-door bin was redundant, and `dsh` is the one terminal entry point.

## Testing

`apps/cli/tests/args.spec.ts` (new; `apps/*/tests` added to the vitest include and `apps/cli/tests` to `tsconfig.host.json`) covers the adapter at the level that matters: mode routing by shape (including `web --dev`), and the exit-code behavior for the fail-loud checks (empty resume/prompt, bad host/port, `--prompt` mixed with a config, unknown option) and `--help`/`--version`, captured through a `process.exit` spy. Both PTY smoke groups in `examples/tui-agent/tests/tui-keyless-smoke.e2e.ts` now drive the real `apps/cli/src/bin.ts`: the `tui-agent` group boots the config as a positional, and the `dsh CLI` group covers default boot, personal overlay, invalid config, the `--resume` config intake, the `process.execve` in-place resume handoff, and the source-path prompt. `examples/cordis-agent/tests/keyless-smoke.e2e.ts` likewise launches through `dsh`. `packages/ui/app-boot/tests/app-boot.spec.ts` drops its `parseResumeArg`/`replaceResumeArg` blocks; the TUI unit and snapshot fixtures use the `dsh --resume {session}` resume command.

## Consequences

`dsh` gains rendered `--help`/`--version` and consistent fail-loud parse errors, and mode routing no longer depends on flag position. Argv parsing lives in one place with one parser idiom shared with the SDK bins, at the cost of a `commander` dependency on `apps/cli` and Commander's parse semantics (its error strings, its `exitOverride` contract) now sitting on the CLI's front door. `dsh-app-boot` no longer owns any CLI-parsing surface; a future consumer needing `--resume`-style parsing composes Commander rather than reviving the deleted scanner. Resuming a session needs no environment variable, and `dsh` is the single terminal front door — the `dsh-tui-demo` package is now a plugin bundle with no bin. Anyone who ran `dsh-tui-demo <config>` or `RESUME_SESSION_ID=<id> dsh-tui-demo` uses `dsh <config>` / `dsh --resume <id>` instead.
