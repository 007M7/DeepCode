# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 外壳内核：`new AppWebEntry(el, seams?).run()` 通过两阶段启动（web2）挂载整个客户端。第一阶段（模块表层）：构建客户端模块系统（`@deepseek-ai/dsh-client-modules`），以主机推送的配置项图（`window.__DSH_BOOT__`）为基础，并行预抓取 `immediately` 层级；执行组合包只会注册 factory。第二阶段（插件表层）：挂载 vendored cordis Loader，并把模块系统作为其 `internal` seam 注入；为每一行图数据创建一个 loader 配置项，另创建外壳自身的 app-shell 组装配置项（tree.import 会物化各模块）；以 settle 作为 AppRoot 的门禁（loader 完全停稳 + 每个配置项 fiber 都为 ACTIVE → 一次切换显示完整 UI）。组合完全由主机图决定：花名册和 immediately 层级都位于负责组合的应用中；外壳不作任何组合决策。

外壳自给自足（web2 硬性规则）：内核不对任何插件包执行值导入；启动状态 store 与信号在这里手写（`loader-status.ts`），因此插件失败时（尤其在失败时）加载页面仍能工作。app-shell 组装（`@deepseek-ai/dsh-client-app-shell`，由外壳拥有、背后没有 npm 包的伪配置项）是唯一通过 `registerStatic` 注册的模块；它与任何插件一样，通过 inject 等待 slots/sessions/layout。

`PLATFORM_MODULES`（src/platform.ts）是共享模块表层的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

可选 `seams` 参数会转发模块系统的 `fetchBundle`／`executeBundle` 传输覆盖（`BootSeams`）；生产调用方省略此参数。它用于测试环境，因为此类环境中的 `<script>` 执行无法到达页面上下文（jsdom）。

外壳拥有浏览器标题投影。选中带有持久标题的会话时，它会渲染 `<session title> — <existing HTML title>` 并响应后续标题修订；未选择会话或选中无标题会话时，会保留现有标题；外壳卸载时恢复标题。现有 HTML 标题仍是可配置的产品后缀。

## 模型体验

无。配置项外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用一次性渲染**：UI 等待启动 settle；只要一个配置项失败，加载页面就会保留并高声逐项报告，不提供部分可用性（渐进式渲染会随其独立项目回归）。
- **窄窗口验收暂缓**：ui-layout 已实现让步链，但外壳级窄视口演练是 P-II 验收项。
