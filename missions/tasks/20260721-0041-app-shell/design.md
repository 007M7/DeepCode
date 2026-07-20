# P0-1 App 壳 layout 骨架 design（arch-session，2026-07-21）

> 依据：用户亲拍四点（progress.md 〇-pre #2/#3）：左栏 slot 化+RpcLog 迁入、session tabs 骨架留坑、右 detail sidebar 默认收起点 tool 卡展开、React 目录两级制。本页 = 容器结构 + slot 注册形态 + 目录约定 + 迁移映射 + 分刀计划。

## 1. 布局容器结构（三栏一顶）

```
┌─────────────────────────────────────────────────────────┐
│ ConnectionBanner（现状保留，fixed 顶条）                    │
├──────────┬──────────────────────────────┬───────────────┤
│ LeftNav  │ Main                         │ DetailSidebar │
│ 48px 图标 │ ┌─ SessionTabs（骨架条）─────┐ │ 默认 width 0  │
│ 竖条+     │ │ 会话 │ 甘特(占位) │ +      │ │ 点 tool 卡 → │
│ 240px 页面 │ ├──────────────────────────┤ │ 320px 展开   │
│ 区(可无)  │ │ <activeTab.render()>     │ │ <detail slot> │
│          │ └──────────────────────────┘ │               │
└──────────┴──────────────────────────────┴───────────────┘
```

- **AppShell**（新，`web-ui/src/shell/AppShell.tsx`）：grid 三列 `48px auto minmax(0,1fr) [width]`——LeftNav 图标条恒在；左页面区宽度由激活 bar 决定（sessions bar=240px 列表；rpclog bar=固定 360px 页面）；DetailSidebar 列宽 0↔320px 过渡。
- **现 SessionsScreen 拆解**：其「sidebar+main」二分升级为壳的职责；SessionsScreen 降级为 sessions bar 的页面组件 + 会话 tab 的内容组件两块（选中态 selectedId 仍是容器局部 state，位置上移到 AppShell——tabs 与 detail 都要读它）。

## 2. Slot 注册形态（三个注册表，同 toolCardRegistry 模式）

全部走「模块级 Map + register 函数返回 disposer + v1 静态调用」——与 toolCardRegistry 同构，将来 cordis 插件线调同一函数纯加法。**注册表放 web-ui（视图资产），不进 store/不进 web-runtime**（红线：store 无业务对象；这些是纯视图注册物）。

```ts
// shell/leftMenuRegistry.ts
export interface LeftMenuBar {
  id: string                    // 'sessions' | 'rpclog' | ...
  icon: ReactNode               // 图标条按钮内容
  title: string                 // hover title
  order: number                 // 图标条排序
  panelWidth: number            // 页面区宽度（px；sessions=240 rpclog=360）
  Panel: ComponentType          // 页面区组件（自取数据，容器件）
}
registerLeftMenuBar(bar): () => void
listLeftMenuBars(): LeftMenuBar[]   // order 排序后

// shell/sessionTabRegistry.ts
export interface SessionTab {
  id: string                    // 'conversation' | 'gantt' | ...
  label: string                 // tab 条文字（中文 UI 文案）
  order: number
  Content: ComponentType<{ sessionId: SessionId }>  // tab 内容（会话上下文注入）
  placeholder?: boolean         // true = 未实现坑位（渲染占位说明页）
}
registerSessionTab(tab): () => void

// shell/detailRegistry.ts —— 右栏内容块
export interface DetailBlock {
  id: string
  match(payload: DetailPayload): boolean   // 认领判定
  Block: ComponentType<{ payload: DetailPayload }>
}
export type DetailPayload = { kind: 'tool-call'; sessionId: SessionId; callId: string }  // v1 唯一成员；union 留扩展
registerDetailBlock(block): () => void
```

- v1 静态注册点 = `shell/builtins.ts`（AppShell 模块加载时调用一次）：sessions bar、rpclog bar、conversation tab、gantt 占位 tab、tool-call detail 块（内容可空——先渲 callId+argsRaw 原始 JSON，富内容归 P1-4 registerToolView）。
- **detail 展开态**：`{ payload: DetailPayload } | null`，AppShell 局部 useState（视图选中态不进全局 store，红线 #14 同款）；ToolCallCard 点击 → 经 props 回调链上抛（纯 props 组件不许 import 注册表）。回调链：ConversationView 增 `onToolCardClick?: (callId: string) => void` → ConversationContainer → tab Content props → AppShell。

## 3. React 目录两级制（用户亲拍 #3）

```
web-ui/src/
  shell/                    # 壳本体：AppShell + 三注册表 + builtins + LeftNav/DetailSidebar 容器
  leftmenu/
    sessions/               # sessions bar：列表页面（现 SessionListContainer/View/Item 迁入）
    rpclog/                 # rpclog bar：RpcLog 页面（现 components/panels/RpcLog/* 迁入改容器形）
  sessiontabs/
    conversation/           # 会话 tab：现 conversation/* 组件迁入
    gantt/                  # 占位 tab：一页说明性占位组件
  components/               # 存量通用件渐进迁（MessageText/JsonBlock 等共享件留此）
  hooks/ utils/ style/      # 不动
```

- **互不 import 规矩**：`leftmenu/<a>` 不许 import `leftmenu/<b>` 或 `sessiontabs/*`（反向同理）；共享件下沉 `components/`。物理防冲突：一人一目录。
- **渐进迁移**：本次只迁 RpcLog（用户点名）+ sessions 列表 + conversation（壳直接受益者）；MessageText/JsonBlock/ToolCallCard 等叶子暂留 components/（多 tab 共享预期）。import 路径全改，git mv 保历史。

## 4. RpcLog 迁移映射（panels/RpcLog → leftmenu/rpclog）

| 现状 | 迁后 |
|---|---|
| 浮动面板：collapsed 角标 RpcLogBadge + expanded 右下 overlay RpcLogBody | 左栏页面：图标条一个 bar 按钮（未读数徽标沿用 unread 逻辑）+ 页面区常驻 RpcLogBody（撑满页面区高度） |
| store.ui.rpcLogOpen 控开合 | 语义改「激活 bar === 'rpclog'」——AppShell 局部 state；**store.ui.rpcLogOpen 保留但语义变**：仍作 unread 清零信号（openRpcLog/closeRpcLog intents 由 bar 切换调用；rpc-log.ts ingest 的 unread 逻辑零改动） |
| RpcLogBadge 角标 | 删组件；未读数变 bar 图标角标（LeftNav 读 store unread） |
| verify-rpclog-panel.mjs 的 badge/overlay 选择器 | 改：点图标条 bar 按钮 → 页面区内容断言（§改动清单见 6） |

## 5. 不做清单（三段式）

| 触发条件 | 返工点 | 预埋 |
|---|---|---|
| cordis 插件要注册 bar/tab/detail 块 | 注册函数挂进插件 apply | 注册表+disposer 已同 toolCardRegistry 形态，纯加法 |
| tab 内容需要跨 tab 共享视图状态（如甘特选中联动会话流滚动） | AppShell 升 context 或引 store ui 切片 | 现 selectedId 已收在 AppShell 单点 |
| detail 需要多 payload 类型（消息详情/审批详情） | DetailPayload union 加成员 + match 分派 | union+match 判定已留形 |
| 左栏页面区要可拖宽 | panelWidth 变 min/max 区间+持久化 | panelWidth 已是 bar 属性单点 |

## 6. 分刀计划与验证

| 刀 | 内容 | 验证 |
|---|---|---|
| 刀 1 布局容器 | shell/ 五件（AppShell/LeftNav/DetailSidebar/三注册表+builtins）+ sessions/conversation 迁目录 + App.tsx 换 AppShell | tsc 绿 + test:gui 不回归 + verify-session.mjs 全绿（列表/会话流选择器不变——类名沿用） |
| 刀 2 RpcLog 迁移 | panels/RpcLog → leftmenu/rpclog 改容器形；删 Badge；LeftNav 未读角标；intents 语义对齐 | verify-rpclog-panel.mjs 选择器同步改+全绿；unread 清零行为断言保留 |
| 刀 3 坑位+detail | gantt 占位 tab + tool-call detail 块（点卡展开/再点收起/内容=原始 JSON）+ §E1-16 断言（tabs 条在/占位页渲/点卡展开右栏/空 detail 兜底） | verify-session.mjs 新增 §E1-16 + tool-card spec 补 onToolCardClick 一例 |

每刀一 commit 一回执；批间清收件箱（事故整改纪律）；只 commit 不 push。

## 7. design 自查修正（对照现码盘后）

1. **语义标签保留**：verify-session.mjs 全套选择器锚 `aside`（列表）与 `main`（会话区）——AppShell 的左栏页面区必须仍渲染为 `<aside>`、main 区仍为 `<main>`，否则刀 1 就砸验收。图标条用 `<nav>`。
2. **verify-session §E1-10 也动**：它点 `button:has-text("RPC")` 断言 `section[class*="panel"]`——刀 2 除 verify-rpclog-panel.mjs 外须同步改 §E1-10（点图标条 bar → 断言页面区内容）。
3. **rpcLogOpen 消费面核实**：仅 intents 三函数 + rpc-log unread 判断 + RpcLog.tsx 开合渲染——迁移映射成立（bar 切换调 openRpcLog/closeRpcLog 保 unread 语义，RpcLog.tsx 的开合判断删除、Badge 删除）。
4. **web-ui 公开面只有 mount()**：App 内部结构随便换，无破坏性导出变更。
5. **测试 import 路径**：tool-card.spec 引 components/conversation/ToolCallCard（留 components/ 不动）、utils.spec 引 ConnectionBanner/hooks/utils（全不迁）——现有 spec 零改动；SessionListContainer/RpcLog 系无 spec 直引，迁移安全。
