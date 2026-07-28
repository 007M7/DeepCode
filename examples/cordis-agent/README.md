# cordis-agent

English | [中文](README.zh.md)

The self-referential harness demo: the DeepSeek V4 coding spine on the full-screen TUI plus [`@deepseek-ai/dsh-tool-cordis`](../../packages/cordis/tool-cordis/README.md), which lets the model inspect the current DSH process, mount in-memory temporary Plugins, and unmount them. Temporary Plugins remain active across turns but disappear on unmount, toolset unload, or DSH restart; they create no files or configuration and may affect other sessions in the process. The `ctx.fs` and `ctx.web` services are provider-only capabilities available to those Plugins. The design lives in [the toolset Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:cordis      # TUI (default)
pnpm run demo:cordis web  # browser UI at http://127.0.0.1:3081
pnpm run demo:cordis acp  # ACP server
```

The intended demo is staged — verify the listener link first, then let the agent extend itself:

```
> Mount a temporary Plugin that listens to the 'agent/status' event and logs every status change, then run `echo hi` with bash.
  [tool call] cordis_mount({"code": "return { name: 'status-logger', apply(ctx) { ctx.on('agent/status', (agent, status) => console.log('status →', status)) } }"})
  [tool result] Temporary Plugin dyn-1 is running (plugin "status-logger"; available until unmounted or DSH restarts).
  [tool call] bash({"command": "echo hi"})
[cordis:dyn-1] status → …            ← the temporary listener firing, live
> Now give yourself a reverse_text tool and use it on "harness".
  [tool call] cordis_mount({"code": "return { name: 'reverse-text', inject: ['tools'], apply(ctx) { ctx.tools.register(harness.defineTool({ name: 'reverse_text', … })) } }"})
  [tool call] reverse_text({"text": "harness"})   ← a tool the agent built for itself, one step earlier
> Unmount both temporary Plugins.
  [tool call] cordis_unmount({"id": "dyn-1"})
```

Ask for `cordis_inspect` with `what: "api"` or `what: "events"` to see the generated service/event reference used to write Plugin code, and mount two cooperating temporary Plugins (`ctx.provide` in one, `inject` in the other) to watch Cordis park and revive the consumer.

## End-to-end tests

`tests/keyless-smoke.e2e.ts` boots the real `cordis.yml` through the Loader with a dummy key and asserts the banner, package-name resolution, and clean EOF exit. `tests/cordis-tools.e2e.ts` is the with-key smoke: a real model mounts a temporary status listener and the test verifies its tagged console line, creates and uses a `reverse_text` tool, and composes two temporary Plugins through provide/inject. [`packages/cordis/tool-cordis`](../../packages/cordis/tool-cordis) carries the unit coverage under the per-file 100% gate.
