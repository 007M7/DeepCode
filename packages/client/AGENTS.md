# AGENTS.md — Web client stack

Rules for `packages/client/*` (the browser side of the dsh web GUI) plus its build entry `apps/web`. They supplement the repo-wide [conventions](../../AGENTS.md#conventions) and the [package rules](../README.md). Before touching slots, component props, stores, or plugin structure, read the [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) (the definitive composition model) and the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) (loading chain, object layer, services).

Packages here are named with the directory prefix: `@deepseek-ai/dsh-client-<name>`.

## Slot and props discipline

The [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) owns the full design; these are the rules you must not violate when writing or reviewing client code:

1. **One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? }, Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The shell alone renders `'root'`.
2. **children = declaration + authorization**: the slots your component renders are exactly the keys of your register call's `children` object (spec values: `kind`/`scope`). Rendering a slot you didn't declare, or declaring one someone else declared, fails at load — do not work around it; the conflict is the design speaking. Slot names mirror the composition path: `<domain>.<entry>.<hole>` (e.g. `'conversation.chat.toolview'`).
3. **Component props are the four shares, all derived**: `PropsRuntime<K>` (SlotMap: owner params + `useSession`/`sessionId` on session scope + `useSessions`) & `PropsRenderSlots<S>` (children keys) & `PropsStore<H>` (store factory) & the inject face. Never hand-write a member a share already derives; never re-type a share locally.
4. **Hooks are framework-made only**: `useSession`, `useSessions`, `useStore`, `renderSlot` are the four seats. Business code never creates a hook or selector as a prop value — pass plain data and callbacks. (Component-internal behavioral hooks that subscribe to nothing external are fine.)
5. **Live data has exactly three channels**: parent knows it → owner props at the renderSlot site; only the component knows it → local state; shared across entries or survives remounts → a store declared at register. Derived data is a pure function over framework-hook data (`useMemo`), never its own subscription.
6. **Stores: read `props.useStore`, write `props.actions.*`** — the declared actions are the complete mutation surface. Write the store as an exported `createXXXStore()` factory (module-level handles are forbidden — de-facto singletons); share by passing one handle to several registers inside `apply`. Production code never calls the factory or `.create()` outside `apply`; tests do (that is the sanctioned zero-machinery path).
7. **inject returns plain data and callbacks** from the apply closure's own ctx — no hooks, no ReactNode producers, no whole-service objects. Its capability boundary is the plugin's declared `inject` topology; there is no wider ctx to reach for.

## Export discipline (client plugin packages)

The `/client` surface of a UI plugin package is a contract face, not a convenience barrel. Three rules, enforced package-wide (do not restate them as per-file comments):

1. **A UI plugin exports no values beyond what cordis loading needs** — `apply` / `inject` (and `Config` where present), plus store factories consumed type-only by components (`ReturnType<typeof createXXXStore>`). Types are the extra allowance: contract types (owner shares, injected shapes, composed props aliases) export freely. Implementation components, pure helpers, constants, and store handles stay internal. Adding any new value export requires user sign-off, not a matching consumer.
2. **Same-package tests import internals directly** — relative `../src/client/xxx.ts` from package tests, or the `./src/*` subpath where a spec lives outside the package. Never widen the public surface to make a test compile.
3. **Cross-package imports of another plugin's symbols are in principle forbidden.** The sanctioned routes are the slot system (register/renderSlot) and ctx services. If neither fits, stop and escalate — do not add an export to unblock yourself.

## ctx discipline (components never see ctx)

`ctx` belongs to the apply world only: the plugin body and the inject factories closed over it. Components — every `.tsx` under a feature domain — receive all data and callbacks **through the four props shares**; they never call a hook that reaches ctx, never import a service class to poke it, never read a React context (business components see zero contexts — `BindingContext` and its kin are renderer-internal). If a component needs something new, the answer is a prop threaded from its share's source (owner site, store declaration, or inject face), not a hook.

## Layering red lines

The stack has one-way knowledge, settled in the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md):

1. **Data object layer** (`runtime`, React-free): `ConnectionController` → `SessionManager` → `Session` own all business state (event windows, streaming accumulation, reconnect machine), and the snapshot-store engine (zustand/immer, `defineStore`, `shallowEqual`) lives here too — store products are bare observable sources with no hook members. Zero React imports — grep-assertable.
2. **Render machinery** (`web-react`, shell-only glue): the whole ctx↔React boundary — slot renderer/outlets, `SessionProvider`, the uSES bridge. Every hook is composed here at the binding site from bare sources; business plugin packages carry no web-react dependency at all.
3. **Presentation components** (plugin packages' `src/client/`, pure props): consumables, expected to be rewritten wholesale. Business logic must not leak into them; everything arrives through the four props shares.

Non-negotiables across the layers:

- **Business data lives in the object layer, never a store.** Entry-declared stores carry shared viewing/interaction state (selection, drafts, panel widths); sessions, frames, and connections stay in the object layer.
- **rpcId is strictly bidirectional**: the initiator mints, the responder echoes; business signatures see only `RpcRequest<P>`, minting stays in the carrier layer ([layering and RPC protocol note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)).
- **Notifier dual-channel discipline**: `notifyNow` only as the direct echo of a user gesture; frame-driven updates always go through `markDirty` (microtask-batched). See `runtime/src/client/sessions/notifier.ts`.
- **The web layer is pure presentation.** Nothing that is "how to draw" (tool-card views, queue states) enters the session log; the host computes such data per frame or pushes it live, and replay recomputes it — falling back to the generic form when it can't. A new *model-visible* input still requires a session event (repo-wide rule).

## Directory regime (plugin packages)

One UI feature = one plugin package (`src/client/` browser half). A multi-domain package splits by future package boundaries — ui-conversation is the exemplar: `contract/` (the only shared face), domain directories that never import a sibling domain, and `apply.ts` as the single cross-domain assembly point; `scripts/verify-client-domain-graph.ts` enforces the levels. Registration goes through `slots.register` in `apply` — never module-level side effects.

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

1. Compose through register: merge the slot contract into `SlotMap`, declare the slot in its parent entry's `children`, register your component — see the [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md). No other composition route exists.
2. Type the props as the four shares (`PropsRuntime` & `PropsRenderSlots` & `PropsStore` & inject face) — derive, don't hand-write. Shared/surviving state goes in a `createXXXStore()` factory declared at register; component-private state stays local.
3. Component tests feed props directly (`createXXXStore().create()` for the store share; plain stubs for framework hooks) — behavior-shaped assertions, no render machinery.
4. Tokens only in CSS; Chinese product copy; English comments.
5. `pnpm run test:gui` green (plus `test:web` if you touched the build surface).
6. Non-trivial change? It needs an Agent Note in the same PR (repo-wide rule) — the GUI notes above are the precedents to extend.
