# `@deepseek-ai/dsh-cmdline`

English | [中文](README.zh.md)

The command line a dsh launcher hands to the app it boots. The launcher parses only its own flags (`--profile`, `--patch`, the config dumps) and hands **everything after them** to the tree verbatim, so an app owns its flag family, its `--help` text, and its parse errors instead of the launcher knowing them.

## The launcher values

A launcher calls `provideCmdline(ctx, host)` before any tree entry mounts, which provides:

- `ctx.cmdlineArgs` — the invocation's inner arguments. `get()` is the whole interface, and it returns a snapshot: `dsh --profile tui --resume abc` yields `['--resume', 'abc']`.
- `ctx.appExit` — a bounded process-exit request, wired to the launcher's shutdown controller.
- `ctx.appReady` — settles when the launcher has finished mounting, for a row that publishes readiness (a URL line a supervisor waits for).

An embedding host with no command line provides an empty list; that is the honest answer, not a missing value.

## Startup rows, and the service their app reads

An app reads those arguments from its **startup row** — a Loader row and plugin that inject `cmdlineArgs` and calls `runStartup(ctx, service, program, plan)`:

```ts ignore
export const name = 'web-startup'
export const inject = ['cmdlineArgs']

export function apply(ctx: Context): void {
  runStartup(ctx, 'webStartup', webCommand(), planWebStartup)
}
```

The Loader-row injection is also its discovery declaration, so no bundle manifest field is needed:

```yaml
- id: web-startup
  name: '@deepseek-ai/dsh-web-app/startup'
  inject: [cmdlineArgs]
```

The launcher finds active rows with that injection in the composed tree and mounts them before everything else.

Every row the app configures from flags then reads what the startup row resolved, naming the key it takes and the value it falls back to:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.get('webStartup')?.host ?? '127.0.0.1'
    port: !!js ctx.get('webStartup')?.port ?? 3080
```

`runStartup` parses the arguments, asks `plan` for the values, and provides them as the service. On `--help`, `--version`, a parse error, or a `program.error(...)` from the plan, it writes commander's text and requests exit — nothing is provided, and the rest of the composition never mounts.

`plan` receives the options of every row that injects the service, for a value that has to take the composition into account: the `/api` fence authorities are the shipped example, since a bind the composition configured decides whether LAN literals are derived at all.

### Why the boot has phases

A row's config expressions are evaluated when the include applies it, and a strict `ctx.get` only answers for a service whose providing fiber is already active. A composition therefore mounts in two passes: active `cmdlineArgs` consumers alone, then everything else. The rows of the later pass read live values, a `--help` exits before the second pass exists, and a user editing a live patch file re-runs that pass against services that are still up, so a flag cannot be silently reset.

`enableRow(ctx, id)` turns on a row a bundle ships disabled because only some invocations want it (`dsh web --dev` and its client-plugin reload chain). Call it from a row that mounts beside the one being enabled, not from the startup row: a row enabled in the first pass would wait for services the second pass has yet to mount.

### One command line, one owner

A composition has exactly one command-line owner. An app that layers over another one disables the underlying startup row and names both services, so the rows it absorbed start on the values their own fallbacks name — [`dsh-headless`](../../bundle/headless/README.md) does this over [`dsh-web-app`](../../bundle/web-app/README.md).

An out-of-tree plugin brings its own commander copy, so commander's control-flow errors are detected structurally rather than by class identity; an identity check would rethrow a printed help as a fatal load failure.

## Model Experience

None, as this package resolves the process's own command line before any session exists.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Launcher flags must precede app arguments.** The split is positional: the first token the launcher does not recognize starts the inner arguments, so `--patch` placed after an app flag belongs to the app. The launcher's parser consumes one `--`, so an app argument that must survive as a literal `--` needs `-- --`.
- **A startup service has no declared owner.** Reading rows name it and a `cmdlineArgs` consumer provides it; nothing links those two injections statically, so a bundle that ships reading rows without its startup row fails at settlement (pending entries naming the service) rather than at load.
- **A user patch that replaces a row's whole `config` drops its expressions.** A flag beats the value written beside it, not a literal a user wrote in place of the expression; keeping the expression is what keeps the flag winning.
