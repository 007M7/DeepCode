# AGENTS.md — Web client stack

Rules for `packages/client/*` (the browser side of the dsh web GUI) plus its build entry `apps/web`. They supplement the repo-wide [conventions](../../AGENTS.md#conventions) and the [package rules](../README.md); read the two architecture notes linked below before structural changes.

Packages here are named with the directory prefix: `@deepseek-ai/dsh-client-<name>`.

## Layering red lines

The stack is three layers with one-way knowledge, settled in the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md):

1. **Data object layer** (`web-runtime`, React-free): `ConnectionController` → `SessionManager` → `Session` own all business state (event windows, streaming accumulation, reconnect machine). Zero React imports — grep-assertable.
2. **Hooks layer** (`web-ui/src/hooks`, pure data): subscribes to object snapshots via `useSyncExternalStore`, exposes plain-data handles. No JSX, no DOM.
3. **Presentation components** (`web-ui`, pure props): consumables, expected to be rewritten wholesale. Business logic must not leak into them; they receive data and callbacks through props only.

Non-negotiables across the layers:

- **No business objects in the store.** zustand carries cross-view presentation state only (`rpcLog`, `ui`, `connection` slices). Sessions, frames, and connections live in the object layer. View-local facts (selection, expansion) stay in component state, not the store.
- **rpcId is strictly bidirectional**: the initiator mints, the responder echoes; business signatures see only `RpcRequest<P>`, minting stays in the carrier layer ([layering and RPC protocol note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)).
- **Notifier dual-channel discipline**: `notifyNow` only as the direct echo of a user gesture; frame-driven updates always go through `markDirty` (microtask-batched). See `web-runtime/src/session/notifier.ts`.
- **The web layer is pure presentation.** Nothing that is "how to draw" (tool-card views, queue states) enters the session log; the host computes such data per frame or pushes it live, and replay recomputes it — falling back to the generic form when it can't. A new *model-visible* input still requires a session event (repo-wide rule).

## Directory regime (`web-ui/src`)

> Shell restructure in progress: the tree is converging to this layout (today's `components/{conversation,sessions,panels}` migrate into it); the regime below is the target every new feature follows now.

Two-level feature directories, one contributor per directory — physical conflict avoidance:

```
web-ui/src/
  shell/                  # AppShell + the three slot registries + builtins
  leftmenu/<bar>/         # one directory per left-nav bar (sessions, rpclog, …)
  sessiontabs/<tab>/      # one directory per session tab (conversation, gantt, …)
  components/             # shared leaves (MessageText, JsonBlock, …)
  hooks/ utils/ style/    # cross-cutting; not feature-owned
```

- `leftmenu/<a>` must not import `leftmenu/<b>` or `sessiontabs/*` (and vice versa). Anything two features need sinks into `components/`.
- Bars, tabs, and detail blocks register through the `shell/` registries (module-level map, `register*()` returns the disposer — same shape as `toolCardRegistry`). v1 registration is static in `shell/builtins.ts`; plugin-driven registration later calls the same functions.
- **Claiming a placeholder slot**: pick a `placeholder: true` tab (or add a bar) in `shell/builtins.ts`, create your feature directory, and replace the placeholder component with your container. Don't build features outside this regime.

## Styling

[docs/web-styling.md](../../docs/web-styling.md) is authoritative. In short: design tokens live in `web-ui/src/style/global.css` (`:root` light values, `[data-theme='dark']` overrides); component CSS references tokens only — no literal color values. CSS Modules + `clsx`; no component library, no tailwind ([framework ruling](../../.agents/notes/implemented/process/2026-07-19-web-styling-system.md)). Product copy is Chinese; code comments are English.

## Testing and coverage

The GUI test structure (three tiers, lane map) is settled in the [GUI testing system note](../../.agents/notes/implemented/process/2026-07-20-gui-testing-system.md); repo-wide policy in [docs/testing.md](../../docs/testing.md).

- **Both client packages are inside the per-file 100% coverage gate** (`pnpm run test:coverage`). `web-runtime` is covered by node-env object/protocol suites; `web-ui` rides the jsdom lane. Genuinely unreachable defensive arms take a `/* v8 ignore -- <reason> */` comment with a real reason, never a bare ignore.
- **web-ui specs are end-to-end behavior checks, not unit tests.** A jsdom spec renders the component with realistic props (or a driven fixture runtime) and asserts what the user would see — never class names, hook internals, or render counts. Components are consumables: behavior-shaped specs survive a rewrite, implementation-shaped specs don't.
- The jsdom environment comes from a per-file `// @vitest-environment jsdom` pragma on the spec's first line — the shared config stays node-env. Start a new spec from an existing one (`web-ui/tests/tool-card.spec.tsx` is a good template).
- **Each tier asserts its own layer.** Data-layer semantics (state machines, wire shapes, reference stability) belong to the `web-runtime` and `apiproxy` suites — don't re-assert them from component specs.

## Before you push: the local check ladder

Run the narrowest rung that covers what you touched; escalate only when the change surface demands it.

1. **Every GUI code change** — `pnpm run test:gui` (seconds; no browser, no server): the client suites plus the host-side GUI packages. This is the inner loop; run it as freely as a typecheck.
2. **Changes to the build surface, boot wiring, or static serving** (`apps/web`, vite config, `dsh-host-webserver`) — additionally `pnpm run test:web`: rebuilds the frontend dist, then runs the browser smoke pair (the real-host case self-skips without `DEEPSEEK_API_KEY`).
3. **Before a PR** — `pnpm run check:pre-push` (the repo-wide gate ladder). Between PR windows this rung is not expected on every commit.

If `test:gui` is red on code you did not touch, neither silently fix nor ignore it: note it in your handoff so it lands in the next PR window's sweep.

## New component checklist

1. Claim the slot (see the directory regime above): one feature, one directory.
2. Build the container in your feature directory; keep leaves pure-props. Wire data through the hooks layer, not by importing business objects into components.
3. Copy a neighbouring jsdom spec into `web-ui/tests/`, keep it behavior-shaped: start from the happy path and the edge states, then widen until the component's branches are covered — the coverage gate applies; only the assertion style stays behavior-level.
4. Tokens only in CSS; Chinese product copy; English comments.
5. `pnpm run test:gui` green (plus `test:web` if you touched the build surface).
6. Non-trivial change? It needs an Agent Note in the same PR (repo-wide rule) — the three GUI notes above are the precedents to extend.
