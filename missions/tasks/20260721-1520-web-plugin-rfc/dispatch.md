# P-I 全 teammate 任务图 终版 v2.1

> v2.1（2026-07-21 深夜）：①「收编 cordis-web」全部改为按 v3 全新实现（用户令：不看别的 worktree）；②开工节奏改**分两批**（用户拍板）：批次1=fw-slots/fw-react/rt-core/ui-shell 随 T0 开工，批次2=ui-side/convo-a/convo-b 于 T2 开工，ui-traj 照旧 T3；③immediately=先行装载组（动态 bundle）、loader 机件壳静态持有——见 v3 §0.3 修订。

> 配套：[api-contracts.md](api-contracts.md)（v3 冻结契约=接口法律）、[plugins.md](plugins.md)（业务+布局规则）、[modules.md](modules.md)（模块规格,与 v3 冲突处以 v3 为准）、[architecture.md](architecture.md)、figma-analysis/。
> 目标：**P-I 收口=UI 插件化系统全链路跑通**（GET /→__DSH_BOOT__→loading 页→loader 以 DI-require 拉全部插件→settled→整 UI 一次成型→会话全功能），个别功能 slot 允许缺。

## 0. T0 骨架刀（主会话亲自，开工令后第一件事）

一刀建齐 **12 个包**骨架 + git mv 迁移，全员开工零等待：

1. packages/client/{ui-slots, ui-primitives, web-react, connection, runtime, ui-layout, ui-sidebar, ui-conversation, ui-trajectory, ui-theme, i18n, web}/ 各建 package.json（名字/exports/依赖按 v3 §0.2）+ tsconfig + src/index.ts **契约桩**（v3 对应节接口全文照抄,实现 `throw new Error('P-I stub')`）+ README（一句话职责+v3 节号）。
2. git mv 迁移按 v3 §11 全部做完（搬家不改码,owner 接手历史连续）。
3. workspace 依赖补：zustand、immer（或 mutative,fw-react 定）、tsdown client preset 模板（按 v3 §9.1 全新写,不参考别的 worktree）+ 每 UI 插件包 watch 脚本。
4. 产物验收=全仓 typecheck 绿（桩类型即契约,实现偏了立刻编译红）。细则=同目录 t0-checklist.md。

## 1. 编制（8 开发 + 1 顾问 + 主会话调度）

**分两批开工**（用户拍板 2026-07-21）：批次1=fw-slots/fw-react/rt-core/ui-shell（T0 后即开,依赖靠桩解耦）;批次2=ui-side/convo-a/convo-b（T2——web-react+runtime 真实现落库后开,骨架期即有真框架可用）;ui-traj 照旧 T3。每人任务书=下表三段+通用纪律块（§2）。

### fw-slots —— ui-slots + ui-primitives + ui-theme + i18n（四包串行,均小）

- 范围：SlotCore（三型语义/订阅版本面/onMutate 桥）+ ScopedSlots/OwnerProps 类型族；ui-primitives（StateDot 四色/ic_ds_ SVG 族——问 figma-flows 要节点数据/Button/Pill/Menu/Input/markdown 族迁入改造）；ThemeService+light/dark 双主题字典（token 抄 figma 报告）；I18nService+zh/en 结构。
- 顺序：ui-slots 最先（fw-react 等它替桩）→ primitives → theme → i18n。
- 验收：三型语义矩阵单测；类型负样本 expect-error；StateDot 四态渲染；theme apply 后 :root 变量断言。

### fw-react —— web-react

- 范围：v3 §2 全部——createSnapshotStore（zustand+immer+subscribeWithSelector+自研 rafFlush 中间件+persist+dev freeze）/bindSnapshotSelector/createSessionProvider（依赖倒置）/scopedSlots 工厂（renderSlot 订阅渲染+注入缓存 WeakMap 链+ErrorBoundary;P-I 单形态无 Suspense）/useInvoke。
- 验收：结构共享断言/raf 合批计数/等值短路/并发重放安全;Provider+scopedSlots 假 core 假 loader 的 jsdom 全套（含越权类型负样本）。

### rt-core —— connection + runtime +（host 侧收编刀）

- 范围：connection 对账导出清单附 v3 §3（含 §3.1 纯度对账清单）；runtime=SlotsService（Service 包装+ctx.emit）/SessionsService（list store/scope 树 mintScope/binding/ancestry）/Session 两行/ClientLoader（__DSH_BOOT__ 消费/script 注入/**闭包 factory+DI require 模块表+导出面回登记**/immediately 组先行屏障/style 归属登记/status;unload=P-I 空实现;机件交 web 壳静态持有——与 ui-shell 对界:实现归 rt-core,boot 挂载归壳）；**host 侧刀（全新实现,不看别的 worktree）**：HostWebPluginRegistry（订 Loader 加载面+读 package.json `dshClient` 声明,client 产物取 exports["./client"]）+ webserver 分发端点 GET /plugins/<id>/client.js + GET / 注入 __DSH_BOOT__。
- 验收：现有 spec 平移全绿;list store 增量/重连;scope 树生命周期（惰性建/frozen 保留/removed 拆）;loader 双模式（真 bundle+fixture 注入）;host 注入端 e2e。

### ui-shell —— ui-layout + web 壳

- 范围：AppFrame（三栏 grid/双拖把手 raf/让步链写死/details 0宽不 unmount）；LayoutService（四面 zustand+persist+prune）；web 壳（把共享依赖实体递给 loader 构造 require 模块表/AppRoot=loading 页→await loader.settled()→真 UI 一次切换/SessionProvider+scopedSlots 装配闭合/vite+多插件构建管线+`dsh web` serve 协调——与 rt-core 对界：壳与构建归我,serve 与注入归 rt-core）。
- 验收：拖宽/开合/让步 jsdom;persist 恢复;boot 冒烟（fixture 起页 loading→settled→整 UI）。

### ui-side —— ui-sidebar

- 范围：v3 §6 全部（SidebarRoot 全结构/treeStore 物化派生/状态点两态数据+四色件/hover …+/搜索/Group-by 菜单 by-workspace）。视觉问 figma-flows。
- 验收：树派生单测（byId+parentId→树/cwd 分组/排序/截断…）;jsdom 交互（展开/搜索/hover）。

### convo-a —— ui-conversation 骨架半

- 范围：ConversationService（scope 寻址 send/cancel/selection per-scope/openDetails 编排/registerView+ViewMap/drafts persist/**startSession 空态首发三连**）;EmptyState 含 project(cwd) 下拉；ConversationRoot（Header 面包屑+按钮排+ViewSwitcher+composer）;InputBar 平移+空态同组件转场;DetailsPanel 极简。
- 验收：service 单测（scope 寻址/root 调用 throw/selection 演化）;骨架 jsdom（空态转场/视图切换/details 开合联动 router）。

### convo-b —— ui-conversation 消息流半（与 convo-a 同包分工,convo-a 任 owner 协调文件边界）

- 范围：ChatView/MessageItem/AssistantMarkdown 平移改注入取数;ToolRow 5 形态（收起⇄展开 leading 槽切换）;ToolViewRegistry（scope filter 生效/解析序/inject 支持）;GenericToolCard 兜底;统计行（chrome.footer 首例）;回到底部;**bash toolview 样例两份注册**（全局+scope filter,第三方姿势独立文件）。
- 验收：消息流 jsdom（fixture 主链路/流式部分帧/tool 展开）;toolviews 注册/差异解析/卸载回退;Profiler 计数（流式期间统计行 0 渲染）;selection 联动（点 tool 行→details 显示 args/result）。

### ui-traj —— ui-trajectory（最后开工,可与 W5 并行）

- 范围：merge ViewMap{trajectory,waterfall}+registerView 两条+占位实现（span 派生粗糙即可,不要求效果）+chrome.header 统计条第二客户。
- 验收：两 tab 出现且可切;chrome.header 渲染;不塌 chat。

### figma-flows —— 常驻设计顾问（已就位）

答数值/hex/节点 id;无稿明说"自定";fw-slots 的图标族导出优先支援。

### 主会话 —— T0 骨架刀/契约仲裁（唯一可改 v3,改后广播）/催报死线/W5 集成验收

## 2. 通用纪律块（每份任务书原文附带）

1. **契约law**：api-contracts v3 对应节=你的接口;觉得错→SendMessage 主会话仲裁,不许自行改接口/桩。
2. **属地**：自己的包+自己的档案（missions/tasks/20260721-p1-<代号>/）;commit pathspec;别的包只读;同包双人（convo-a/b）由 a 划文件边界。
3. **三不改**：wire 协议/host 权威层（rt-core 的收编注入刀除外）/Session 核心逻辑（两行加法除外）。
4. 组件规矩：组件文件零框架 import（一切经 props）;相等性协议（结构共享/Object.is/shallowEqual,无深比较）;订阅结果不进 state;列表父订 id 子订内容;CSS Modules only+token vars,禁 :global 越界。
5. 小步快跑：每个可编译单元落盘+一句话回执;>15 分钟零落盘催报;写优先少大读。
6. 测试随包（宽松期口径:关键逻辑有测即可）;`--no-verify`;无 co-auth 尾注;**严禁 push**。
7. 视觉问 figma-flows,架构问 main,不猜。

## 3. 里程碑

| 节点 | 判据 | 动作 |
|---|---|---|
| T0 | 骨架刀落库,全仓 typecheck 绿 | 八份任务书群发,全员开工 |
| T1 | ui-slots 真实现落库 | fw-react 删桩 |
| T2 | web-react+runtime 真实现落库 | ui-shell/ui-side/convo-a/b 删桩换真包（此前用桩写组件与测试照常） |
| T3 | ui-layout+web 壳落库（浏览器 loading→settled→三栏 UI） | 全员接壳联调;ui-traj 开工 |
| T4 | 全包实现齐 | 主会话跑 W5 验收,问题按包派回 |
| T5 | 验收全绿 | P-I 收口,progress 归档,等用户 review |

## 4. W5 集成验收清单（P-I 全链路跑通的标准）

**验收形态（用户 2026-07-22 补充要求，凌驾于下列各条的执行方式）**：
- **真跑，不是静态绿**：headless/playwright chromium 访问真主页面（树根 .env 有 DEEPSEEK_API_KEY，起真 host 真模型跑）；「静态检查 OK 但跑不起来」=不通过。
- **截图对视觉稿**：对已定稿要做的功能逐屏截图（三栏常态/空态/暗色/details 打开/tool 行展开等），与 figma-analysis 三份定稿事实逐项对比（间距/圆角/色 token/布局结构）；不做的功能不比。截图进 .artifacts/（gitignored）；对比结论记档案。
- **常见交互动线亲自走一遍**：至少——刷新冷启动→loading→整 UI；空态首发（选 cwd→输入→发送→会话建立流式回显）；切会话再切回（保温秒显）；点 tool 行→details 联动；拖宽/折叠侧栏；暗色切换；断线刷新恢复。运作流程有卡点=不通过，修完钉回归断言（conventions #6）。

1. **装载链 e2e**：GET /（真 host+fixture 双模式）→ __DSH_BOOT__ 注入→loading 页→pinned 先行拉取→`loader.settled()`→整 UI 一次成型;单插件人为 fail→loading 页显式报错(fail loud);unload→注册收回+style 移除。
2. 现有功能等价：test:gui 语义等价改造+verify-session 等价版+verify-session-real（真 host）;RpcLog 断言退役记档。
3. 新面各一条 e2e：三栏拖宽/开合/让步链;树列表展开+状态点;details 极简联动（点 tool 行→args/result）;**toolviews 差异渲染**（bash 全局+scope filter 两注册各自命中+卸载回退兜底）;暗色切换（style 变量断言）;空态→有内容同组件转场。
4. Profiler 计数：流式期间统计行=0/邻行=0/历史 MessageItem=0;切 session sidebar=0。
5. 断线刷新恢复+cold session 打开。
