# cordis-agent

The self-referential harness demo: the DeepSeek V4 coding spine on the full-screen TUI plus [`@deepseek-ai/dsh-tool-cordis`](../../packages/cordis/tool-cordis/README.md), which hands the model three tools over the **live cordis runtime it is running inside** — inspect it, mount new plugins into it, and dispose them again. The `ctx.fs` and `ctx.web` services are mounted (provider-only, no model-facing file/web tools) so the plugins the agent writes have real capabilities to build on; Node built-ins are trapped in the sandbox and redirect to those services. The design (sandbox semantics, mount lifecycle, cross-mount composition, caveats) lives in [the toolset Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:cordis
```

The intended demo is staged — verify the listener link first, then let the agent extend itself:

```
> Mount a plugin that listens to the 'agent/status' event and logs every status change, then run `echo hi` with bash.
  [tool call] cordis_mount({"code": "return { name: 'status-logger', apply(ctx) { ctx.on('agent/status', (agent, status) => console.log('status →', status)) } }"})
  [tool result] mounted dyn-1 (plugin "status-logger", state: active)
  [tool call] bash({"command": "echo hi"})
[cordis:dyn-1] status → …            ← the mounted listener firing, live
> Now give yourself a reverse_text tool and use it on "harness".
  [tool call] cordis_mount({"code": "return { name: 'reverse-text', inject: ['tools'], apply(ctx) { ctx.tools.register(harness.defineTool({ name: 'reverse_text', … })) } }"})
  [tool call] reverse_text({"text": "harness"})   ← a tool the agent built for itself, one step earlier
> Unmount both.
  [tool call] cordis_unmount({"id": "dyn-1"})
```

Ask for `cordis_inspect` with `what: "api"` or `what: "events"` to see the generated service/event reference the agent writes plugin code against, and try two cooperating mounts (`ctx.provide` in one, `inject` in the other) to watch cordis park and revive the consumer.

## End-to-end tests

`tests/keyless-smoke.e2e.ts` boots the real `cordis.yml` through the Loader with a dummy key and asserts the banner, package-name resolution, and clean EOF exit. `tests/cordis-tools.e2e.ts` is the with-key smoke: a real model mounts a status listener and the test verifies its tagged console line, creates and uses a `reverse_text` tool, and composes two mounts through provide/inject. [`packages/cordis/tool-cordis`](../../packages/cordis/tool-cordis) carries the unit coverage under the per-file 100% gate.
