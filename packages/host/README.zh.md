# host/ — web GUI 宿主侧

[English](README.md) | 中文

dsh web GUI 的宿主侧：所有客户端形态共用的 API 网关，以及承载它的纯 HTTP 服务器。浏览器侧位于 [`client/`](../client/README.md)；组合后的应用是 [`apps/cli`](../../apps/cli/config/base.cordis.yml)，它负责服务 [`apps/web`](../../apps/web/)。全部为**产品**包。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `apiproxy/` | 共享 API 网关：零 Node 依赖的 TS 协议契约（`src/api/`）、fetch 载体对（宿主侧 `toFetchHandler`、客户端侧 `AbstractApiClient`），以及基于 `ctx.agents`／`ctx.workspace` 的宿主实现 | `ctx.apiProxy` |
| `webserver/` | 纯 HTTP 路由注册载体：激活即监听的 `node:http` 服务器；路由以命名的 `exact`／`prefix` 处理器注册 | `ctx.httpServer` |
| `directory-picker/` | 工作区目录选择 seam：网关的 picker RPC 委托的可辨识 `native`／`browse` 能力 | `ctx.directoryPicker` |
| `directory-picker-native/` | 双面原生交互：OS 选择器后端（osascript／PowerShell／Zenity+KDialog，仅宿主屏幕可用）+ 由浏览器侧填入 ui-workspace 目录流 slot | （注册 `ctx.directoryPicker`） |
| `directory-picker-browse/` | 双面浏览交互：基于 Node 标准库的列举／创建原语（可远程）+ 由浏览器侧渲染应用内选择工作区目录对话框 | （注册 `ctx.directoryPicker`） |
| `directory-picker-auto/` | 自适应选择器：启动时一次性判定宿主处境（绑定宿主、SSH、显示），并把匹配的双面后端挂载为内存中的 Loader 条目 | （挂载一个后端行） |

`apiproxy` 在设计上与传输方式无关——它不注册任何路由；载体自行包装 `ctx.apiProxy`。HTTP 载体路由（连同其 `/api` 浏览器信任栅栏）由 [`client/connection`](../client/connection/README.md) 的 node 半侧挂载，这正是该包住在 client 组的原因：它拥有这条协议链路的两端。
