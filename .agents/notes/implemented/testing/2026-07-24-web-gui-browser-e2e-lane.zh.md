# Agent Note: Web GUI 的无密钥浏览器 e2e 车道

Status: implemented

[English](2026-07-24-web-gui-browser-e2e-lane.md) | 中文

## 问题

Web GUI 以一条真实组装链交付——chromium 页面 → client 插件 bundle → HTTP 单次 RPC + 两条 SSE（Server-Sent Events）流 → `toFetchHandler`/apiproxy → host 端的 agent loop（智能体循环）、工具与 JSONL 持久化——却没有任何测试无密钥且确定性地检验这条链。[GUI 测试体系](../process/2026-07-20-gui-testing-system.md)覆盖第 1 层（Node 中的协议同构）、第 2 层（对象层状态机）与第 3 层冒烟测试，但无密钥冒烟驱动的是 `FixtureApiClient`——没有 host、没有 wire、没有 agent loop——而全链路冒烟需要 `DEEPSEEK_API_KEY` 和真实模型，因此不确定、在无密钥 CI 中自行跳过。[docs/testing.md](../../../../docs/testing.md) 的快照哲学——带密钥录制一次、永久无密钥回放、格式变动时刷新——已覆盖 ACP（Agent Client Protocol）、headless `stream-json` 与 TUI 三个文本记录（transcript）表面；web 表面是唯一没有这层保障的组装形态。而缺口恰恰是两起已实证 GUI P0 藏身之处：fixture（测试前置数据）客户端短路掉的 wire 承载链。

## 决策

`pnpm run test:web` 携带 `apps/web/tests/` 下的无密钥、确定性浏览器 e2e 车道：录制的会话日志 fixture 经 `@deepseek-ai/dsh-llm-replay` 对真实进程内 web 组合回放，断言规范化后的会话区 aria 预期输出加进程内世界状态。不新增包（package）；产品侧增量为 `dsh-llm-replay` 的增量接口（`paceMs`、`ReplayHandle`，以及 `{ patches }` 覆写形式：对派生脚本按索引增补，使一份 sidecar 无需复制已录分片即可表达「第 N 次调用抛错/挂起，其余照录回放」），一处由重试场景暴露的 `dsh-llm` 修复（携带的 `failure` 快照对任何 Error 都生效——此前的 `instanceof` 判定会在两份包副本并存时丢弃提供方错误码，即源码平面回放叠在 lib 平面 boot 之上的情形），以及 web 组合此前缺失的 `llm-retry` 行。

### Scaffold：`apps/web/tests/scaffold.ts`

一个普通的共享 fixture 模块（[测试政策认可的形态](../../../../docs/testing.md)），不是包：值得门禁把守的逻辑——回放推导、会话解析、日志脱敏、持久化——都在已受门禁的包 `dsh-llm-replay`、`dsh-acp-snapshot`、`dsh-session-persistence-jsonl` 中；剩下的只是启动接线和浏览器胶水，而驱动 chromium 的源码在无浏览器的覆盖率 runner 上无法诚实保持逐文件 100% 覆盖率。

`launchWebScaffold()` 通过 vendored Loader 的 include 机制，从交付的 `apps/cli/cordis.yml` 启动真实 web 组合——与 `AppCLIEntry` 为 `dsh web` 驱动的是同一棵树、同一套机制。差异全部经 include patch 覆盖在这棵树上，即 ACP `cordis.snapshot.yml` 模式的进程内表达：临时 `persistenceRoot`；禁用 `workspace-context`（录制的 fixture 不得嵌入本仓库的 AGENTS.md）；禁用 `session-title-llm`（其发后不管的标题调用会与循环争抢会话的回放游标）；webserver 行钉到端口 0 加已构建 dist；无密钥模式下禁用 `llm-deepseek`。patch 的 id 一旦不再匹配任何行，boot 扫描会大声失败而不是漂移。boot 在临时工作区 `chdir` 下运行，使 api-gateway 的 `process.cwd()` 会话默认值、工具 cwd 与 fixture 一致；`dsh web` bin 自身的胶水（argv、profile json、AppCLIEntry）仍由 `smoke-real.e2e.ts` 中的无密钥 CLI 冒烟把守。初始化回滚和正常关闭都会先对 Cordis 树执行 dispose（资源释放），再删除 scaffold 持有的两个临时根目录；每项清理都会独立尝试，并会报告清理失败而不掩盖初始化失败。

无密钥的模型替换 = 禁用适配器行的 patch 加 `installLlmReplay` 在停稳的根 ctx 上以提供方目录（providers-catalog）模式填充开放的 seam——绝不用 catch-all：适配器行被禁用后不存在任何适配器，catch-all 会让 `resolveModelContext` 无路由可走，`compact-basic` 的步后压力检查将步步告警，而不是被可证明地闲置（发布的 128k `contextWindow` 使该路径对小 fixture 保持闲置）。选择直接安装而非插入回放插件行是刻意的：直接安装返回收尾消费检查所需的 `ReplayHandle`。没有 fixture 的场景让 seam 保持空置，任何离群的流式调用都会以 NO_ADAPTER 大声失败。

`seedSession()` 通过真实持久化 API 播种冷会话——一次性 `Context` 挂载 `SessionStore` + `SessionPersistenceJsonl` 指向 host 的根目录，`create()` + `append()`，一次 `utimes` 回拨保证侧栏顺序确定（`semantic-checkpoint.snapshot.ts` 先例）——绝不裸写文件，因此播种器对桶哈希、文件名编码、压缩一无所知，host 的 zstd 默认值也无需任何启动开关。种子在播种时即校验（可解析、以 `turn/end` 结尾——未闭合的最终轮次会被恢复（resume）的崩溃修复改写）。

### 确定性规则

回放模式下浏览器断言的屏障栈，按序：（1）host 侧 `await agent.whenIdle()` 加超时，以进程内 `turn/end` 为锚——空闲翻转发生在持久化落盘之后，一次等待同时覆盖轮次完成与持久性；（2）浏览器安定轮询（流式输出节点已卸载、最终文本可见）。录制模式下，日志采收在 `whenIdle()` 之后、scaffold 释放之前进行，此时运行中的会话仍然可用。单独监听进程内 `turn/end` 是错误屏障（它先于 SSE 帧到达浏览器、先于 fsync 触发）；文件轮询被禁止（NFS 上慢，且被 `whenIdle` 取代）；`networkidle` 被彻底禁止（SSE 流保持打开时它永不解析）。

不做单次瞬态 DOM 断言：从回放产出到 React 提交的每一跳都可能合并分片，采样 `[data-streaming]` 天然就是竞态。流式输出的增量性由持久化的 `assistant/chunk` 事件断言（模型可见 ⟺ 已记录，使日志成为权威证据）。`dsh-llm-replay` 的可选 `paceMs`（默认缺省 = 突发）只是让浏览器观察到真正增量 SSE 的真实感旋钮；正确性绝不依赖它，且节奏等待期间中止会即时取消。

每个场景都会因任何 pageerror 或客户端的连接丢失/间隙修复控制台警告而失败：否则重连机制加历史重同步会把一条死掉的 SSE 通路自愈掉，套件反而认证了坏 wire。Scaffold 的 `close()` 调用 `ReplayHandle.assertConsumed()` 收尾检查（每个已录脚本都被绑定、每个游标都耗尽），把静默的少放与错绑变成清晰诊断。车道不设 vitest 重试；每文件一个 chromium、每场景一个新 context、每场景一个 host；视口固定；交互选择器锚定 role、`data-*` 属性和可见文本，而 frame 与会话区采集则使用既有的 CSS 模块局部类名锚点。

### 预期输出

每场景一份提交的预期输出：会话区规范化 `ariaSnapshot()`（`ui.expected.md`）——uuid/cwd/工作区目录名/时长归一为稳定 token，在安定里程碑处轮询至两次相等再采集——外加几条 role/文本锚断言，让保语义的组件重写在预期输出可评审地变动时仍保持绿色锚点。aria 树是 client 规则「断言用户所见，绝不断言类名」的机械化。世界状态断言内联在根上下文的会话事件上（哪次工具调用产生了哪项已持久化的工具结果、`turn/end` 是否完成）而不是第二份提交的日志预期输出：持久化日志表面已由 ACP/headless/TUI 套件经同一循环和持久化钉住，在此重复钉住会违背分层纪律、翻倍刷新成本。`refresh` 是预期输出的唯一写入者——回放模式下预期输出缺失会连同修复命令一起报错，而不是静默自举。

类型检查平面切分是结构性的：启动 host 主干的三个文件（`scaffold`、`replay-round-trip.e2e` 和 `seeded-history.e2e`）被排除出注册在 client 侧的 `apps/web` 工程。这三个文件及其共享的 `support.ts` 逐文件纳入 `tsconfig.host.json`——一个程序不能同时持有 cordis `Context` 合并的两侧。

### 模式与 fixture

`DSH_SNAPSHOT` 以内联 spec 分支选择 replay（默认，无密钥）、record（带密钥）或 refresh（无密钥）——TUI 的形态，不是套件工厂：两个场景撑不起 acp-snapshot 工厂机制，且真正共享的部分已被导出（`scrubRequestHeaders`、`parseSessionLog`、`installLlmReplay`）。每个 spec 切分为驱动步骤（输入、发送、`whenTurnSettled`——所有模式都执行，绝不等待模型内容选择器，因此 record 不会因真实模型答法不同而挂起）与断言步骤（仅 replay/refresh）。Record = 经真实输入框实时驱动 + 采收内存中的 `session.header`/`session.events`（TUI 的 `rawSessionLog` 形态——无需文件解压）+ `scrubRequestHeaders` + `{{sessionId}}`/`{{cwd}}`/`{{rpcId}}` token 化；随后一次无密钥 refresh 重新生成 `ui.expected.md`。每个发起提示的场景，其 fixture 都经此流程对本组装录制。一条漂移防线把每个 spec 的驱动提示词与 fixture 录制的 `user/message` 绑定。fixture 清单防线保持每个场景目录封闭（精确文件集合，每个 JSONL 都是脱敏不动点，不含当次运行的 `rpcId`）。Web fixture 全部脱敏请求头且不钉任何头类别，沿用 TUI 先例而非[钉住请求头](2026-07-06-pin-request-header-content-in-one-scenario.md)的严格读法——见「暂缓」。

### 场景

1. **`replay-round-trip`**——新会话，经真实输入框发送提示词，回放流式输出推理（reasoning）+ 一次在临时工作区真实执行的 `bash` 工具调用 + 最终文本（15ms 节奏）。断言安定后的 markdown、aria 预期输出与内联世界状态（这次 bash 调用的已持久化工具结果严格等于 `WEB_E2E_OK\n`、完成的 `turn/end`、>10 个分片事件）。
2. **`seeded-history`**——冷播种一份已录会话；侧栏列出它（分组行 → 会话行，默认折叠），打开后纯凭日志经 `session.history` 内的隐式冷恢复挂载渲染工具卡片与文本——replay 下零模型调用，因此没有任何绑定约束；record 模式实时驱动同一轮（真实 `read` 工具读取播种的工作区文件）来产出种子。
3. **`live-interactions`**——一段不含工具调用的已录轮次经覆写 sidecar 承载三个仅回放的场景：sidecar 的内容本身写在 spec 里，每次运行时在 spec 自有的临时目录中生成文件（重试追加所用的派生成功条目经 `deriveReplayScript` 从 fixture 重新派生，绝不复制进已提交的 sidecar）。取消：一个带 `readyFile` 标记的 `{ patches }` `hang`——标记文件的存在证明流在测试点击 Stop 之前已停驻在轮次中途，使流中取消按构造即确定（`turn/end` 原因为 `aborted`，输入框重新启用）。AUTH 错误：一次落在 llm-retry 可重试集合之外的分片前 `throw`（`turn/end` 原因为 `error`，零条 `llm/retry` 事件，输入框恢复可用）。SERVER 重试：第 0 次调用 `throw` + 在第 1 次调用处追加 fixture 自身的成功条目，凭持久的 `llm/retry` 记录在浏览器中端到端证明 llm-retry（`request/header` 仅在变化时记录，因此尝试次数在那里不可见）。
4. **`question-composer`**——已交付组合中常驻的 `ask_user_question` 接管：一段已录轮次在真实的 userInteraction seam 上阻塞于步骤中途，提问输入框（`[data-question-key]`）在浏览器中渲染，测试经它作答（这是驱动步骤对模型内容作出反应的唯一获准之处：没有这个回答，轮次无法完成，record 与 replay 皆然），工具结果携带所选的 label。预期输出：提问输入框稳定的等待态。
5. **`steering`**——在提问输入框阻塞该步骤时做轮次中途 steering（中途引导），此即确定性的轮次中途窗口，不依赖任何时序。输入框在运行期间锁定，因此这一 steer 由页面经客户端所用的同一条同源 `/api` wire POST `session.prompt` `mode:'steer'`（`TODO(web-steer-composer)`：待有输入框手势后改为驱动它）；下游的一切都是产品路径——gateway → `Agent.steer` → 步骤边界排空 → 持久的 `steering/message` → SSE → 带徽标的插话气泡。record 模式的 fixture 诚实性：除非真实模型的最终回复遵循了一条只有 steering 消息才携带的指令，否则该次录制被拒绝。
6. **`navigation-panes`**——一份内容丰富的双轮次种子（轮次 1：同一条 assistant 消息内的 bash + 两次并行 read；轮次 2：一段 markdown 密集的回复）经 seeded-history 模式冷渲染（零模型调用），承载四个表面：侧栏搜索（客户端标题过滤；仅在持久的标题随 attach 基线一同到达后才断言，因为冷的 `SessionSummary` 不携带标题，而搜索匹配的是用户所见的 `displayTitle`；反例查询清空整棵树，正例查询收窄，清除后复原）、Trajectory 标签页（轮次分节 + 步骤组的工具构成，外加视图区 aria 预期输出）、Waterfall 标签页（span 统计 + 每个 span 一条泳道；只有 assistant/steering 节点携带轮次编号，因此 P-I 折叠会将一个轮次 0 的序幕 span 计入，按原样钉住）与详情列（bash 工具视图行把点击路由到 openDetails；打开/关闭状态断言在 frame 的 `data-details-collapsed` 属性上，因为关闭把网格列收缩到宽度 0 而不卸载子树）。
7. **`lifecycle-chrome`**——一段极小的已录纯文本轮次驱动三个整页关注点。真实 wire 上的 Workspace 动线：空态 hero 的首次发送物化出真实的 Workspace + Session（jsdom 的 `workspace-flow.snapshot.ts` 套件基于 fixture 客户端钉住这一状态机；本场景则经 HTTP RPC + SSE + gateway 钉住它），其持久证据是会话头部的 cwd 恰为按名创建的目标 `<workspaceRoot>/workspace`，外加 hero 等待态的 aria 预期输出。重新加载恢复：折叠侧栏（持久化于 `dsh.layout.panels`），`page.reload`，整个表面纯凭持久化完整归来——布局保持折叠，选中项恢复（`dsh.sessions.current`），已录轮次从 `session.history` 重新渲染且零模型调用（已耗尽的回放游标使任何离群请求都在 close 时大声失败）。暗色模式：产品尚无任何控件能切换主题，因此本场景驱动 ThemeService 的整个 DOM 契约（即 `body[data-ds-dark-theme]` 属性），并钉住已交付的级联：alias token 翻转，某个实际绘制的表面重绘，移除该属性则精确还原亮色采样值（`TODO(web-theme-gesture)`：待有真实设置控件后升级为驱动它）；按范围裁定，主题/布局不设预期输出（aria 感知不到颜色）。

### CI 立场

车道随 `pnpm run test:web` 交付、豁免门禁，与该配置头部注释所记一致。往 CI 加 chromium 会推翻 [GUI 测试笔记](../process/2026-07-20-gui-testing-system.md)中「CI 无浏览器基础设施」的前提，因此需要自己的 Agent Note 并从那里交叉链接，分阶段推进：先作为非必需任务，再以量化标准晋升（连续绿色运行次数、耗时、零重试的抖动预算、runner 浏览器缓存策略）。`TODO(ci-browser)` 标记该接缝。场景目前面向 POSIX（车道不在 Windows 矩阵中）。

## 业界先例

调研了 AI 聊天/agent web UI 与 mock 层（LibreChat、vercel/ai-chatbot + AI SDK、lobe-chat、open-webui、OpenHands、Chainlit、continue、cline、langfuse、gradio/streamlit；Playwright HAR/route、MSW、Polly/nock、WireMock、aimock）。自有后端的应用的主流成熟架构是：真实后端 seam 后放一个进程内伪造/回放模型，下游全部真实（LibreChat 的 `LIBRECHAT_TEST_RUN_HOOK` 伪模型；ai-chatbot 的 `MockLanguageModelV3` + `simulateReadableStream`；continue 的脚本化 mock 提供方类）——这正是 `dsh-llm-replay` 已然所是。浏览器层 SSE 拦截无法检验增量渲染（`route.fulfill` 一次性交付整个响应体；playwright#33564），且服务端 SSE 栈完全失测，因此各项目只把它用于边缘用例。分片节奏作为 fixture 参数反复出现（LibreChat 默认 10ms 附慢速档；ai-chatbot 500ms）；CI 里的真实模型会腐烂（open-webui 的套件长出 120 秒超时，先被禁用后被删除）；会话在持久化层以受控时间戳播种（LibreChat 直插回拨时间的 Mongo 文档；langfuse 播种其数据库）。没有任何被调研项目为 UI 测试把录制的 agent 事件日志经真实后端回放——最接近的是提供方层录制 fixture（aimock）与前端层 socket 历史发射（OpenHands MSW）——因此会话日志即 fixture 的设计沿着本仓库「模型可见 ⟺ 已记录」不变式所指的方向比业界先例多走了一步。

## 曾考虑的替代方案

**浏览器网络层 SSE 拦截（`page.route`）。** 已否决：`route.fulfill` 无法流式输出，增量 token 渲染无从检验，且服务端 SSE/背压/关闭路径——两起已实证 P0 的藏身处——完全失测。

**`DEEPSEEK_BASE_URL` 处的 mock HTTP 提供方。** 作为本车道机制已否决（仅保留给既有的工作区探针冒烟）：fixture 会变成手写的 OpenAI SSE 字节脚本，一种与仓库其余部分录制回放的会话日志格式渐行渐远的第二 fixture 格式；适配器的真实 HTTP 路径归带密钥 e2e 管。

**扩展 `?fixture` 客户端。** 已否决：分层纪律——`FixtureApiClient` 的存在意义就是脱离服务器测试客户端 shell；client API seam 以下按构造即失测。

**用占位 `DEEPSEEK_API_KEY` + 回放拦截替代禁用适配器行。** 尽管零组合改动且树内有两处先例仍被否决：它用谎言满足 `llm-deepseek` 的快速失败密钥检查，还留下一个挂载却被拦截的死适配器；禁用行（ACP overlay 的同款做法）是诚实的无密钥，并在最早可解析点快速失败。

**`packages/support/web-snapshot` 包 + `defineWebSnapshotSuite` 工厂。** 已否决：驱动 chromium 的源码在无浏览器的覆盖率 runner 上无法诚实保持逐文件 100%，且两个场景就上工厂是从单一消费方过度泛化，真正共享的逻辑已从受门禁的包中导出。重启条件：出现第二个 web 形态消费方，或 ≥6 个场景的内联分支被证实各自漂移；届时包边界将画在无浏览器一侧。

**第二份提交的规范化会话日志预期输出。** 已否决：日志表面已由 ACP/headless/TUI 套件经同一循环与持久化钉住；在此只会翻倍刷新成本并重复测试下层。内联在根上下文事件上的世界状态断言保住了验证世界的义务。

**以 `DSH_SNAPSHOT` 回放分支拉起 `dsh web` bin。** 已否决：它需要在交付的 CLI 中增加测试专用回放分支和环境变量管道。进程内 scaffold 已加载同一份 `apps/cli/cordis.yml`；只剩 argv、profile JSON 和 `AppCLIEntry` 胶水不在其覆盖范围内，而这些路径已由无密钥 CLI 冒烟覆盖。

**为可测试性改 wire 协议。** 已否决：契约已有第一等的无密钥同构 seam（`InProcessApiClient(toFetchHandler(api))`），逐事件不合批的 SSE 恰是回放在浏览器中可观测的原因，测试一条不再交付的 wire 会颠倒该层的存在意义。

**以真实模型浏览器测试充当无密钥车道。** 已否决：按构造即不确定；被调研的前车之鉴（open-webui）长出无界超时后被删除。带密钥的 W5 冒烟仍是真实模型侧的补充。

**客户端 `data-dsh-busy` 安定信号。** 暂缓：两个场景下多条件安定轮询已经够用，host 侧 `whenIdle` 屏障承担了重活。重启条件：第一次安定轮询抖动，或某场景需要等待 DOM 不暴露的状态。

## Testing

车道自身：`pnpm run test:web` 与既有冒烟对一起无密钥运行所有场景；`DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/<spec>` 对真实模型重录某场景的 fixture；`DSH_SNAPSHOT=refresh` 无密钥重写各份 aria 预期输出。`paceMs` 校验、节奏下限、节奏中中止、`assertConsumed` 的两种失败形态，以及 `{ patches }` 的接受/拒绝路径（按索引换入保留邻项、`at == length` 追加、越界/非整数大声失败）钉在 `packages/support/llm-replay/tests/llm-replay.spec.ts`。

## 暂缓

- **Web 头类别钉住**：web fixture 处处 token 化 `{{system}}`/`{{tools}}`，没有场景钉住 web 组合的提示词/工具 schema（`TODO(web-header-pin)`——scaffold 的 `recordFixture` JSDoc 有标记）。沿用 TUI 处处脱敏先例；当 web 组装的请求头与其镜像的 repl 组合进一步分叉时重审。
- **CI 浏览器供给**：推翻 CI 无浏览器裁定，分阶段标准见上（`TODO(ci-browser)`）。
- **恢复后追问场景**：真实 wire 上的历史/实时缝合路径；当该代码变更或回归时作为独立场景补充。
- **Web 错误表面**：客户端不消费任何 `agent/error` 帧，分片前的失败也没有可冻结的部分输出，因此不可重试的提供方失败不渲染任何错误文案——用户看到的只是发送就此停住。AUTH 场景钉住当前契约（不崩溃、输入框恢复可用、轮次记录为 `error`），`FIXME(web-error-surface)` 标记了待 UI 长出错误渲染后断言可见错误文本的位置。
- **输入框 steering 手势**：输入在运行期间锁定（只能停止或等待），因此 steering 场景从页面走 wire 做 steer；`TODO(web-steer-composer)` 待产品长出真实的输入框手势后，把驱动步骤升级为该手势。

## 后果

Web 表面获得了录制一次/永久回放的层级：真实 chromium → SSE → apiproxy → 循环 → 工具 → 持久化的链路以约 10-30 秒无密钥运行，重复运行结果确定，fixture 由车道自身持有并可重录。接受的成本：每次有意的会话 UI 变更都以一次无密钥 `DSH_SNAPSHOT=refresh` 收尾（预期输出变动是受评审的 diff，锚断言保住语义绿色）；aria 格式归 Playwright 所有——仓库唯一不受自己控制的提交快照格式——因此 playwright 版本升级必须是刻意的升级加刷新提交（依赖在 `apps/web/package.json` 中浮动为 `^1.49.0`；若变动伤人则改为精确锁定）；回放的首次调用顺序绑定把每个场景限制为至多一个发起提示的会话，消费断言是绊线；`compact-basic` 与会话共享回放游标，仅在发布的 128k 目录窗口下保持闲置；在 CI 反转被单独决策之前，车道只在其运行之处（本地，`test:web`）把守回归。
