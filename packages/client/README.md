# client/ — web-GUI browser half

English | [中文](README.zh.md)

The browser side of the dsh web GUI: shell kernel, module system, wire consumer, React-free object services, the slot system, and the `ui-*` feature-plugin roster. Authoring rules live in [AGENTS.md](AGENTS.md); the host half is [`host/`](../host/README.md). All **product** packages, named `@deepseek-ai/dsh-client-<name>`.

| Package | Role | ctx key / slot |
|---|---|---|
| `web/` | Shell kernel: `AppWebEntry` runs the two-stage boot over the host-pushed entry graph | (boots the tree) |
| `modules/` | Client module system: browser peer of Node's ESM loader as a lazy CJS table under the vendored cordis Loader | (module face) |
| `web-react/` | Shell-side React glue: `createSlotRenderer` + `SessionProvider` render seats | (renderer install) |
| `connection/` | Wire consumer both ends: browser `ctx.connection` (shared api client + stream loop) and the node half mounting the `/api` route with its browser-trust fence | `ctx.connection` |
| `runtime/` | Client cordis boot and React-free object services: slots, Sessions, Workspaces, per-session bindings | `ctx.slots` `ctx.sessions` `ctx.workspaces` |
| `hmr/` | Dev-only hot reload for script-loaded client plugins (`--dev` graphs) | (dev entry) |
| `locale/` | Browser locale preference (`zh`/`en`) plus the ns×locale dictionary registry | `ctx.locale` |
| `ui-slots/` | Slot registry pure core: SlotMap merging, single `register` API, the four-share props family | (types + core) |
| `ui-theme/` | Theme preference over the `--dsw-*` token stylesheets (`light`/`dark`/`system`) | `ctx.theme` |
| `ui-primitives/` | Pure React atoms: icons, Button/Pill/Menu/Modal/Input, markdown family | (component library) |
| `ui-layout/` | Shell three-column AppFrame; declares `sidebar` / `conversation` / `details` / `conversation.empty` | `ctx.layout` |
| `ui-sidebar/` | Sidebar shell: Workspace/session rail, search, collapse; declares `sidebar.workspaces` | (slot host) |
| `ui-workspace/` | Shared Workspace picker: browser region + hero picker over the same creation flow | (fills `sidebar.workspaces`, `conversation.hero.workspace`) |
| `ui-conversation/` | Conversation domain: skeleton, chat view, input dock, per-tool row slots | (slot host) |
| `ui-trajectory/` | Trajectory/Waterfall view tabs; the minimal pure-consumer plugin exemplar | (fills `conversation.view`) |
| `ui-command/` | Command surface: session-keyed directory cache, `/` source, three-kind dispatch | `ctx.command` |
| `ui-slash/` | Input trigger pipeline: `/` and `@` detection, grouped candidate menu, source roster | `ctx.slash` |
| `ui-skill/` | `/`-trigger skill reference source over the `skill.list` RPC | (registers into `ctx.slash`) |
| `ui-subagent/` | `@`-trigger subagent reference source over the sessions snapshot | (registers into `ctx.slash`) |
| `ui-model/` | Model selection: `/model` popupSelect + the composer model seat over `ModelService` | `ctx.models` |
| `ui-question/` | Web `ask_user_question`: host half mounts the tool, browser half fills the composer seat | (fills `conversation.composer`) |
| `ui-settings/` | Settings shell: trigger chrome + modal panel; declares the `settings.*` slots | (slot host) |
| `ui-settings-general/` | Settings ownerless copy: chrome content + General section skeleton | (fills `settings.*`) |
| `ui-models/` | Models settings nav entry (content column lands in a later phase) | (fills `settings.section`) |

Feature UI composes only through the slot system (`ctx.slots.register`) — the [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) is the definitive model; the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) owns the loading chain and object layer.
