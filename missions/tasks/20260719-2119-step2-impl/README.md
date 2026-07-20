# step2 协议实现（dispatcher: apiproxy-design）

契约基线：`../20260719-1902-apiproxy-api-design/design.md` **v1.5（冻结）**。任何契约疑问回 dispatcher，不得自行改契约。
纪律：GUI 期间跳过仓库门禁（不写测试/不跑 coverage 门），只求 typecheck 过 + 能跑通。

**UI 首里程碑（2026-07-19 21:3x 用户拍板，对话流后置）**：布局分区（左导航 Sessions/Settings、右主区留白）+ **右下角 RPC 调试面板**（所有 unary 往返 + SSE 帧台账，rpcId 信封第一个消费者）。验收：浏览器打开 → 左栏真实 session 列表（session.list 真 RPC）→ 调试面板见 bootstrap unary 往返 + mux/host 帧滚动。

**已定 React 架构（写进 W4/W5 任务书）**：React 不碰流/不发请求——runtime 层 ConnectionController 消费 AsyncIterable → fold → 写 zustand store；组件 `useStore(selector)` 直连 zustand（无 bridge 层）；写路径 = runtime 导出 intent 普通函数集（内调 ApiClient + 写 store）。rpcLog 采集点在 createApiClient 包/解包咽喉（载体层选项 `{onEnvelope}`，不污染契约签名），有界环形 buffer ~500 条。

## worker 分工

| W | 范围 | 状态 |
|---|---|---|
| W1 | `packages/host/apiproxy/src/api/`（契约包：五域接口、rpc.ts 三信封、rpc-map.ts、zod schemas）+ typecheck | **完成 21:55**（worker 连折三茬后 dispatcher 依批准下场直写；14 文件，typecheck 绿） |
| W2 | `impl/`（boot core 上实现 ApiProxy）。**最小先行**：session.list + events 两流（点亮调试面板）；history 分页/prompt+rpcId spike/审批问答 registry 并行晚到 | 待 W1 冻结 |
| W3 | `fetch/`（toFetchHandler 两级 parse / createApiClient mint+拆封+`onEnvelope` tap）+ apps/dsc `/api/*` 接线 | 待 W1 冻结 |
| ~~W-design~~ | **已移交独立 teammate ui-design**（21:4x 用户调整分工，直接向主会话汇报不经本 dispatcher）；本处 worker 已停、任务书作废、无部分产出 | 移交 21:4x |
| W4 | web-runtime 编码（照 ui-design 的设计文档） | 待设计过用户 review；届时是否回本 dispatcher 调度另定 |
| W5 | web-ui 编码（同上） | 同上 |

## UI 六问拍板（2026-07-19 21:5x，已注入 W-design）

| 问 | 答 |
|---|---|
| Q1 主题 | 架构双主题、先只做亮色；`:root` 亮色实值 + `[data-theme='dark']` 占位；**切换按钮保留可点**（暗色不完善也不藏不禁用，用户明示） |
| Q2 面板形态 | 强浮动：右下角浮层（折叠徽标/展开浮层覆盖内容之上），不占布局流 |
| Q3 导航 | 左栏上段 Sessions 列表占大头 + 下段固定 Settings 入口 |
| Q4 列表交互 | 选中态 + **新建 session 按钮**（session.create 真 RPC；intent 加 createSession）；重命名等不做 |
| Q5 面板权限 | readonly 纯观察 |
| Q6 CSS | CSS Modules + PostCSS + clsx，不引组件库（deepseekchat 同模式） |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 21:22 | 归档建立；W1 派发（后台） |
| 2026-07-19 21:3x | 用户拍板 UI 首里程碑重塑（布局+调试面板，对话流后置）；W2 拆最小先行、W4 提优先级、W4/W5 任务书按 React 架构决策重写 |
| 2026-07-19 21:4x | 用户修正流程：W4/W5 设计先行；W-design 派发（单文档 ui-milestone1-design.md），视觉小节留占位 |
| 2026-07-19 21:5x | 六问答案到齐注入 W-design 收口；评审链=dispatcher 契约 review → team-lead → 用户通过才开 W4/W5 编码 |
| 2026-07-19 21:4x | W1/W-design 双双 API 超时零落盘，杀掉按「分批落盘铁律」重派（W1r 七批 / W-design-r 三批）；5 分钟存活检查点纪律启用 |
| 2026-07-19 21:4x | 用户调整分工：UI 设计移交独立 teammate ui-design；W-design-r 停止（无部分产出）；本 dispatcher 收窄为纯协议实现（W1→W2/W3） |
| 2026-07-19 21:55 | **W1 契约包完成**（21:43 检查点 W1r 仍零落盘 → 杀掉，dispatcher 依 team-lead 批准下场直写）：api/ 14 文件（5 域 ts+schema 对、rpc/rpc-map/index），typecheck 绿。**实现注记**：仓库 exactOptionalPropertyTypes 与 zod .optional() 输出不兼容，schema 锚定统一为 `satisfies z.ZodType<Wire<T>>`（Wire=深度 undefined 宽化，rpc.schema.ts 有文档），透传宽分支（SessionEvent/ContentBlock/RpcError/帧 union）与 brand id 保持显式 cast+注释——设计层「satisfies 锚定」精神不变，形式微调，回头补进 design.md §0.5 |
| 2026-07-19 22:42 | **api/ 14 文件按 v2.0 四象限改写完毕，typecheck 绿**：rpc.ts（四具名 union+窄形+RpcReceipt+错误码删两个）、rpc-map（6 key+RequestPayload/ResponseValue）、sessions/host 签名 RpcRequest<P>、events 流 yield RpcRequest<帧>+帧字段改名（approvalId/questionRpcId）、approvals/questions 改 payload 形状（域接口取消）、barrel 按消息层分组、schema 全层跟改（四具名全形 schema+respond payload schema）。W2 旧模型废码 impl/api-proxy.ts 已删。期间 W2/W3 已死（超时/手停），待重派 |
| 2026-07-20 01:1x | **备案（session-design 联调改动，契约 owner review 通过）**：client.ts URL base 改 resolveBase()——浏览器=location.origin（真网络下假域名 DNS 失败）、无 location 或 origin==='null'（file://、沙箱 iframe）=dsh.internal 注入基；Node 同构管道零影响。apiproxy exports 补 `./api`、`./client` 浏览器安全出口（指 src .ts，GUI 期可；发布前需转 lib 产物——记 hygiene 欠账） |
| 2026-07-19 23:51 | **provider/model 缺省 bug 修复**（team-lead 真 HTTP 探针发现 turn 即错）：bootHost 加 `provider?/model?` 配置与 `HostDefaults`（缺省 deepseek / deepseek-v4-flash 同 demos）；createApiProxy 收 defaults 参数——create/resume 注入 agentOptions、describe 回报同一来源（契约 §3.2「host 级默认现值」语义闭环）；契约 create payload 加 provider?/model? 留 additive 后补。**全链自证通过：prompt 后真模型 assistant/chunk 流出**（进程内同构，60s 探针 exit 0）。双 typecheck 绿 |
| 2026-07-19 23:45 | **W2 第二批完成**（session-design 验收开闸触发）：history 消息边界分页（尾向前扫 surface 消息计数、sourceEventSeqs 归组切 seq、尾页含 partial、DEFAULT_MAX_MESSAGES=50）；prompt 真分发（queue→send/steer→steer，**rpcId 经 MessageSource 透传 spike 落地**——api/sessions.ts merge 声明 `{kind:'user'; rpcId}`，模型面零传输词汇）；cancel 真分发；冷 session 隐式 resume + Map 并发去重。SSE 探针修复顺带：handler.fetch 签名对齐全局 fetch（进程内 (url,init) 调用形归一化）。**进程内同构探针三连过**：create ok / history 空页 ok / not-found 错误码 ok。双 typecheck 绿。respond/审批 registry 仍后置（PendingCard v1 只展示） |
| 2026-07-19 23:04 | **W2/W3 范围由 dispatcher 下场完成**（W2v2/W3v2 重派后又双双超时零落盘/零进展，杀掉直写）：impl/api-proxy.ts（describe/list/create/mux/host 两流真实现+FrameQueue；history/prompt/cancel/respond stub 带 TODO）、fetch/handler.ts（UNARY_ROUTES 6 路由两级 parse+path==method、/api/respond、SSE ServerRequest 全形）、fetch/client.ts（窄形↔全形、onEnvelope 四象限 tap、unary 超时、streaming SSE 解析、respond 入口）、apps/dsc bin.ts /api/* 桥接（node:http↔WHATWG+SSE 流式写出）、apiproxy index.ts 导出四件套。apiproxy+dsc typecheck 双绿。**调试面板地基（W1+W2最小+W3）全就位**，待 ui-design 稿过审后 W4/W5 编码接 onEnvelope |
