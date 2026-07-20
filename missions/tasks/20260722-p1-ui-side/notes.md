# ui-side 施工档案（P-I sidebar 插件）

> owner: ui-side teammate。范围 = v3 §6（packages/client/ui-sidebar）。契约：api-contracts v3 §6（上游 §1/§2/§4/§5）、plugins.md §2.1+§0.1、figma-analysis/sidebar.md。

## 文件计划（刀序）

| 刀 | 文件 | 内容 |
|---|---|---|
| 1 | src/index.ts（node 空 apply）、src/client/tree.ts、tests/tree.spec.ts、package.json、tsconfig.base.json(+/client path)、tsdown.config.ts | 双入口拆分骨架 + 树派生纯函数（byId+parentId→树/cwd 分组→project/排序/搜索过滤/相对时间）+ 单测 |
| 2 | src/client/store.ts | treeStore：SnapshotStore<SidebarTreeState>，订 sessions.list → 物化 rows；expandedIds/query 动作 |
| 3 | src/client/SidebarRoot.tsx + .module.css + 行组件 | Logo 行+折叠钮/New Session/Search/区头+Group-by 菜单/树列表/Foot Settings |
| 4 | src/client/index.ts（apply 注册 sidebar 坑 + inject 工厂） | 接线：useTree=treeStore.useSelector、actions={open,create,toggleSidebar} |
| 5 | tests/sidebar.spec.tsx | jsdom 交互（展开/搜索/hover …+），真框架包 |

## 关键决策（照抄契约/模板处不记）

- **派生模型**：输出扁平 rows（ProjectRow 54h / SessionRow 34h+depth），组件零派生。project=cwd 分组（无 cwd 归 "(no directory)" 组）；session 树=parentId 链，parent 不在同组或缺失时视为根。
- **排序**：project 按组内最新 updatedAt 降序；session 兄弟间 updatedAt 降序（figma 无明稿，最近优先；契约只说"排序"）。
- **搜索**：title 大小写不敏感子串；命中行连同祖先链强制可见（派生可见性，不改 expandedIds）。
- **展开态**：expandedIds 单集合（project 用 cwd key，session 用 id）；初始全收起（onboarding 稿）；点选会话所在链不自动展开（后置）。
- **状态点**：P-I 仅 running→'ongoing'，其余不亮（台账 #1）。
- **截断**：标题 CSS ellipsis（§0.1-9），depth 不设上限；缩进 22px/级。
- **ctx 取用**：RootBinding.ctx cast 后 `ctx.get('sessions')`（撞名仲裁前照抄 ui-layout service.ts 做法）；ctx.layout 直接用（layout 已 declare merge）。

## 进度

- [x] 刀1 骨架+tree.ts+单测（e6b645306+3984e5ee4，22 测）
- [x] 刀2 store（9f618a5a5，6 测）
- [x] 刀3 组件（102a78eb9 Rows / 4704ee298 SidebarRoot）
- [x] 刀4 apply 接线（904b655e9）
- [x] 刀5 jsdom 交互测试（5affd899e，9 测；累计 37 全绿）
- [x] tsdown bundle 验证：dist/client.js 31.4kB，DSHClientProxy.loadPlugin 闭包工厂形状对

## 精调波次（2026-07-22 预告）

- 待 figma-flows style-spec.md sidebar 批落盘 → 全件逐值对账（行高/缩进/padding/字号行高/hover 面/区头/搜索框/Foot），偏差清单+修缮一次回执。
- 待 fw-slots 落鱼 logo 进 primitives → 换 Logo 行（现为 deepseek 文字 wordmark 占位）。
- 自查已修：session 行状态点移到标题前（0f8793eee，figma sub-cell 槽序）。
- 已递 figma-flows 三问：①展开 chevron 悬沟槽 vs 行内换向（现=行内） ②「└」拐角连线补不补（现=无，需 SVG） ③20px 批尾 spacing+底部渐隐遮罩（现=统一 gap4 无遮罩）。答复落地前维持现状。

## 遗留/台账

- 行级「…」菜单：按钮已挂（hover 出现），菜单内容 figma 未定稿——预留锚点，条目后补（plugins.md §1 S 层预留）。
- Foot Settings=占位（无行为），Notice 徽章未做（figma 隐藏元素）。
- Group-by 菜单 Update/Status 置灰（无稿，figma §3 实证）。
- 状态点仅 running→ongoing（台账 #1）；done/error/amber 数据源后置。
- 树行 selected 高亮依赖 useCurrent 注入（layout.current）；activeGroup 蓝 folder 只在该组展开时可见。
- rt-core 在途：packages/client/runtime/src/client/ 未 commit 且有编译错，挡 tsc -b 引用构建；本包验证用 tsc --noEmit -p 绕行，rt-core 落库后应回归 tsc -b。
- New Session/区头新建 workspace 两入口 P-I 都=create()（无 cwd 选择下拉，figma 隐藏箭头后置）；project 行 + = create(该组 cwd)。create 后自动 layout.open。
