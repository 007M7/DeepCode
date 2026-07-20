# ui-shell 实现计划（ui-layout + web 壳 + tsdown client preset）

> owner=ui-shell（常驻）。契约=api-contracts v3 §5/§9.1/§9.3/§0.3（immediately=先行装载组、loader 机件壳静态持有）；验收面=plugins.md §0.1 规则 1/2/5/6 + dispatch ui-shell 行。T0 骨架刀完成前不动 packages/。

## 1. ui-layout

### 1.1 AppFrame 让步链（核心算法，抽纯函数）

```
computeColumns(viewportW, sidebar: PanelState, details: PanelState) →
  { sidebarW, centerW, detailsW }
```

输入=观看态原值（persist 的用户偏好永不被让步链改写）；输出=本帧生效列宽。链序（写死）：

1. 期望值：sidebarW = sidebar.open ? sidebar.width : 0；detailsW = details.open ? details.width : 0；centerW = viewport − 两侧。
2. centerW ≥ 640 → 完成。
3. clamp details：detailsW = max(300, viewport − sidebarW − 640)。
4. 仍不足 → clamp sidebar：sidebarW = max(240, viewport − detailsW − 640)。
5. 仍不足 → auto close details：detailsW=0（**派生关闭，不写 details.open**——窗口回宽自动恢复，persist 语义不被让步链污染）。⚠假设待 main 确认。
6. 兜底：sidebar 已到 240、details 已 0 仍不足 → centerW=剩余全部（可 <640，中栏兜底）。

纯函数单测穷举边界；组件层只做接线。

### 1.2 AppFrame 组件

- 三栏 grid：`gridTemplateColumns: ${sidebarW}px minmax(0,1fr) ${detailsW}px`；viewport 宽经 window resize 监听（rAF 节流）进本地 state。
- 两条拖拽把手：sidebar 右缘 + details 左缘。pointerdown+setPointerCapture → pointermove 记最新 x → rAF flush 调 layout.setSidebarWidth/setDetailsWidth（service 内 clamp [240,420]/[300,520]）→ pointerup 释放。把手命中区 ≥8px 宽（视觉窄条+padding）。
- **details 收起/让步=0 宽不 unmount**：第三列 0px + overflow hidden，子树保留。
- 组件零框架 import：布局态经 props 注入 hooks（useSidebar/useDetails selector）+ actions（引用恒定）；三坑一律 `slots.renderSlot`；中右两坑包在 SessionProvider 内（组件经 props 收 `SessionProvider: FC`）。
- CSS Modules，只用 `var(--dsw-*)`；sidebar 右描边/背景等 token 见 figma sidebar §5。

### 1.3 LayoutService（四面观看态，zustand+persist）

- `current: SnapshotStore<NavState{sessionId?, viewFor}>`、`sidebar/details: SnapshotStore<PanelState{open,width}>`——createSnapshotStore(persist opt-in)，四面全 persist（刷新恢复选中+布局）。
- 默认：sidebar {open:true, width:300}；details {open:false, width:360}。P-I details 全局不随 session（规则5，per-session keyed 升级位=将来把 details 换 keyed store，接口不动）。
- `open(id)`：校验存在于 ctx.sessions.list，不存在=throw（fail loud）。`openView(id,view)` 写 viewFor。
- prune：订 sessions.list → removed id 清 viewFor 条目；current.sessionId 指向已删会话时置 undefined（⚠后者契约未明写，按 fail-safe 补，待 main 确认）。
- SlotMap declare merge 三坑 + apply 里 ctx.slots.define 三条（single；sidebar=root，conversation/details=session）。

## 2. web 壳（packages/client/web）

### 2.1 boot 时序

1. 入口（vite 产物）：静态 import cordis/react/react-dom/ui-slots/web-react/ui-primitives + **loader 机件**（代码家在 runtime 包，壳静态 import——见 §4 对界）。
2. new cordis Context（root ctx）→ 实例化 loader → 挂 ctx.loader → 播种模块表六实体（与壳同实例，插件 require 到同一 React/cordis）。
3. import ui-theme 的 src/styles/ 两份 CSS 为 base 样式表（vite 静态引入；t0-checklist 已知坑：font-family base 变量 T0 补档）。
4. createRoot → `<AppRoot>` boot loading 页（纯壳组件：logo+loading，零插件依赖，样式独立不依赖插件 CSS）。
5. `loader.start()`（读 __DSH_BOOT__：immediately 组并行→其余拓扑）→ `await loader.settled()`。
6. settled 成功 → AppRoot 一次切换真 UI；单插件失败 → loading 页显式列出 failed 插件 id（订 loader.status store），不做部分可用。

### 2.2 真 UI 装配闭合（settled 后，壳内一处）

- `SessionProvider = createSessionProvider({ useCurrent: ()=>ctx.layout.current.useSelector(s=>s.sessionId), resolveBinding: id=>ctx.sessions.binding(id) })`。⚠契约缺口：SessionProviderDeps 无 slots/core 注入位，provider 要渲染 conversation+details 两坑拿不到 renderSlot 来源——已报 main 仲裁（fw-react 属地）。
- `slots = scopedSlots(core, 'sidebar','conversation','details')`（layout define 的三坑显式转授壳）。
- AppFrame 组件经 loader 模块表 `require('@deepseek-ai/dsh-client-ui-layout')` 取导出面（壳持有 loader，settled 后可读），props 注入 §1.2 全套后渲染。
- SessionProvider 渲染的两坑需落进 grid 第 2/3 列：需要 provider 输出 display:contents 兼容结构（与 fw-react 对齐 DOM 形状，随上条仲裁一并定）。

### 2.3 构建管线拓扑

```
packages/client/web:  vite build（壳 bundle：react/react-dom/cordis/纯库三包/loader 机件/AppRoot/boot）
                      index.html 模板（__DSH_BOOT__ 占位由 host 注入）
8 个插件包:            tsdown -c 引用共享 preset → dist/client.js（闭包工厂,CSS 内联,external→require）
dsh web serve:        host webserver 托管壳 dist + GET /plugins/<id>/client.js + GET / 注入
                      —— serve/注入归 rt-core；壳 dist 位置与构建归我
dev 工作流:            壳 vite build --watch；插件 tsdown --watch；手动刷新（无 HMR）
```

## 3. tsdown client preset（T0 模板后接手）

- `packages/client/tsdown.client.ts` export 工厂（入参 {id}）：
  - banner `window.DSHClientProxy.loadPlugin({ id: '<id>', factory: (require) => {`；footer `return <模块导出面>; } })`——导出面含 apply，loader 装载后登记模块表。
  - external=模块表清单（react/react-dom/cordis/ui-slots/web-react/ui-primitives + 全部 @deepseek-ai/dsh-client-* 插件名）→ 编译为 require('<spec>') 调用。
  - CSS Modules 内联：css 文本进 bundle，执行时注入 `<style data-plugin="<id>">`（loader 做归属登记以备 unload）。
- 验收：桩包跑一次 tsdown 产物形状对（T0 保证）；真验收=loader 双模式 e2e（rt-core）+ 我的 boot 冒烟。

## 4. 与 rt-core 对界（需对齐两点）

1. **loader 机件静态 import 缝**：请 runtime 包给专用子路径（如 `./loader`）只导 ClientLoader 机件——壳静态打包若走 runtime 主入口会把 SessionsService 等整个 client 半边捎进壳 bundle（死代码+与动态 runtime bundle 双实例风险）。
2. 壳 dist 位置/静态托管路径约定（serve 归 rt-core，dist 归我）。

## 5. 测试计划（宽松期口径）

- computeColumns 纯函数单测：让步链 6 步各边界（正好 640/差 1px/双 min/兜底）。
- LayoutService：persist 写入与恢复（localStorage stub）、clamp、open 校验 throw、prune（removed→viewFor 清+current 置空）。
- AppFrame jsdom：拖宽（pointer 序列+rAF mock）、开合、让步（innerWidth patch+resize）、details 0 宽子树仍挂载。
- boot 冒烟：fixture __DSH_BOOT__ → loading 页可见 → settled → 真 UI 一次成型；单插件 fail → 错误页。浏览器级=playwright chromium headless（dev server 监听 0.0.0.0），过验收清单后才交。

## 6. 台账/待决

| # | 事项 | 状态 |
|---|---|---|
| 1 | SessionProviderDeps 缺 slots 注入位 | ✅仲裁 932716e02：renderBody 归壳装配+RootBindingProvider |
| 2 | 让步链 auto-close details=派生不写 persist | ✅仲裁钉入 v3 §5 |
| 3 | current.sessionId 指向 removed 会话的清理 | ✅仲裁：同刀置 undefined（已实现+spec） |
| 4 | runtime `./loader` 子路径 | ✅入 v3 §4；等 rt-core 实现（main.ts 阻塞点） |
| 5 | loader 构造入参 {ctx, modules} + requireModule 读面暴露 | 已报 main 转 rt-core |

## 7. 进度台账（2026-07-22）

已落库（ui-layout 完毕；web 壳除 main.ts）：
- cf250b9b1 vite alias 新包名
- d1dc6660d columns.ts（让步链纯函数）
- 706ca157c service.ts（LayoutService）
- 21dcdcf7b/3700f1b7a AppFrame css+组件
- f6d665612 index.ts 换桩+apply（provide layout+define 三坑）
- 9121dc811/cdce14bd2/f24cad7db AppRoot（settled 显式信号门）
- 9cbb90caf seed.ts（模块表九实体）
- 88f71372d app.tsx（装配闭合 renderApp）
- 32e2b7ddf/9dc01069f/0d802b42b 三套 spec（13+8+7 全绿）
- 6ad0724a7/cfe6c30c4 branded id 边界修正

已续（2026-07-22 下半场，刀16-25）：
- 4315d2040 双入口拆分（src/client/=模板，其余七包同型修正已记 t0-checklist §6b）
- 7d4bdf65d tsdown preset 全链跑通（lightningcss CSS Modules 内联三坑记录在 commit）+56ca5c43b scripts
- fd2b0604d ctx.get('sessions') 适配（typed merge 仲裁挂起，回改点已注释）
- fb0e3251b base.css / fa9677d10 main.ts（boot 链闭合）/ 8adf5e9a2 AppRoot gate spec
- 7982cd23f support 路径修 / 6d07dfba0 删 kernel-boot.legacy（放行）
- 14aaa88c6 vite loader alias；壳 build 通过；playwright 探针实证 loading 页+fail loud+token 生效（.artifacts/shell-boot-probe.mjs 可重放）

已续（刀26-30）：
- 98328966a smoke-fixture→boot-chain e2e 4 例（真 carrier+真 chromium+真 ui-layout bundle；W5 判据1 keyless 半，已验收）
- 2bb72f801 .gitignore packages/client/*/dist/（dist 不入库规矩）
- 1f353a261 conversation.empty 跟改（SlotMap+define+壳 renderEmpty fallback；bundle 重跑）
- 80db01da9 旧 smoke-real describe.skip+注明（裁决口径；免门禁台账：旧壳语义 e2e 退役待重写，PR 窗口算账）
- rt-core 跨属地 inject=['slots'] review 通过；新规矩：client 半边用 ctx.<service> 必须 export const inject

已续（刀31-32）：
- c5c9f6577 service.spec branded SessionId 清零（sid() 帮手；TS17004 归 fw-react 刀5 不动）
- f02fd36c2 **T3 浏览器实证**：boot 链 e2e 成功路径——五真 bundle（immediately 四+layout）经 ?fixture settled 一次翻转三栏，7 例全绿。调试插曲：壳 dist 陈旧会报 require 查无（loader 双形登记是后加的）——遇 require 报错先重跑 vite build 再查因

已续（刀33+真链探针 2026-07-22）：
- 437dc7596 W5 smoke-real 骨架：真 dsh web spawn（树根 .env 显式加载——CLI 只读 cwd 的 .env）+三动线（冷启动/拖宽 persist/刷新恢复）+w5-*.png 逐屏截图+八包 bundle 就绪门（含 exports.apply 检查）自动开闸
- 真链探针（.artifacts/smoke-real-probe.mjs）：真 key 真 host 下壳/装载链/注入端全通；卡点=ui-conversation 无 apply（convo-b 在途）+ui-trajectory 无 client（T3 开工件）——批次2 落球即全通
- clsx 表外炸发现→rt-core 9c6f41c47 已治（client 半 noExternal 表驱动全内联）

已续（七包 W5 首轮 2026-07-22 03:0x）：
- 统一重建七 bundle+壳 dist（main 采纳的重建前置）→ .artifacts/w5-seven-probe.mjs：进程内装配（真 host 真 key，trajectory 行过滤）
- 结果：冷启动三栏 OK（w5-01）、EmptyState OK（w5-02）、**首发即白屏**（w5-03）——pageerror=conversation.selection scope 丢失
- 诊断已报 main（convo 属地）：conversationInject 经 b.ctx need('conversation') 后读 scoped.selection，scopeOf(this.ctx) undefined——疑 cordis traceable this.ctx 回绑丢 extend 元数据
- 附带发现（fw-react 面）：inject 工厂在 EB 外执行，单插件 inject 抛错=全树白屏——已建议挪进 per-entry EB

已续（T4 验收跑 2026-07-22 03:3x，.artifacts/w5-full-probe.mjs）：
- 八包+壳全新构建；ui-trajectory 落球（4767249fa）后八包门全开
- **过 2 卡 6**：01 冷启动三栏✅、07 暗色 token 级联✅；02 首发白屏（scope bug 未修，原样复现）→03-08 全被毒化
- 过程发现：runtime/i18n lib/ 半陈旧→mountWebPlugins fail loud——统一重建前置应含 tsc lib 半，已报 main
- theme.apply 的 UI 切换入口无 owner（P-I 无稿），台账

已续（T5 达成 2026-07-22 04:1x）：
- P0 修复（585671106，双实例内联根因）后 w5-full-probe **8/8 全绿零 pageerror**；重建前置=tsc lib 半+八 bundle+壳 dist
- 金图 w5-09：bash data-sample 行→details 三栏联动（args JSON+Output+蓝描边）——selection 通道+toolviews 差异渲染全链实证
- **探针 selector 经验**：CSS Modules [hash]_[local] 使 class 子串选择器失效——用 data-variant/data-clickable/data-sample 等 data-* 稳定锚点（已报 main 建议作 e2e 规范）
- 截图 w5-01~12 共 15 张就绪待 figma 对比

已续（收尾刀 150ac71f8）：
- smoke-real 正式断言=探针 8 动线回灌（真 host 真 key 实跑 8/8 绿，18s——同 host 复用下真模型轮次极快）
- P0 白屏回归钉：首发后 body 近空=双实例内联类 bug 复发（注释点名 585671106）
- data-* selector 规范沉淀进文件头注释；双门 skip 保持（无 key/bundle 未就绪）

**P-I ui-shell 属地收口**。台账仅剩：
- ClientContext/ts-probe 终裁后：ui-layout declare merge 跟改（一处）
- theme.apply UI 切换入口无 owner（P-I 无稿）
- 让步链 auto-close 的浏览器级验收在窄窗视口（<1180px）未实跑——jsdom spec 已覆盖，视口矩阵留 P-II
