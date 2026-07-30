# host/ — web-GUI host half

English | [中文](README.zh.md)

The host side of the dsh web GUI: the API gateway every client shape shares, and the plain HTTP server it rides on. The browser side lives in [`client/`](../client/README.md); the composed application is [`apps/cli`](../../apps/cli/config/base.cordis.yml) serving [`apps/web`](../../apps/web/). All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `apiproxy/` | The shared API gateway: the zero-Node TS wire contract (`src/api/`), the fetch carrier pair (`toFetchHandler` host-side, `AbstractApiClient` client-side), and the host implementation over `ctx.agents`/`ctx.workspace` | `ctx.apiProxy` |
| `webserver/` | Plain HTTP route-registration carrier: `node:http` server listening on activation; routes register as named `exact`/`prefix` handlers | `ctx.httpServer` |
| `directory-picker/` | Workspace-directory picking seam: discriminated `native`/`browse` capability the gateway's picker RPCs delegate to | `ctx.directoryPicker` |
| `directory-picker-native/` | Dual-face native interaction: OS-chooser backend (osascript / PowerShell / Zenity+KDialog, host-display only) + the browser half filling ui-workspace's directory-flow slots | (registers `ctx.directoryPicker`) |
| `directory-picker-browse/` | Dual-face browse interaction: listing/creation primitives over Node stdlib (remote-capable) + the browser half rendering the in-app Select Workspace Directory dialog | (registers `ctx.directoryPicker`) |

`apiproxy` is transport-agnostic by design — it registers no routes; carriers wrap `ctx.apiProxy` themselves. The HTTP carrier route (with its `/api` browser-trust fence) is mounted by [`client/connection`](../client/connection/README.md)'s node half, which is why that package lives in the client group: it owns both ends of the wire.
