# Settings 可透出面清单

调研日期 2026-07-20。范围：`dsc web` 形态下，Settings 页能从 harness（node host）透出/操纵什么。全部逐项对照当前源码核实（file:line 以本 worktree 为准）。只列清单不设计。

## 阅读指引

- **归属**：`host` = 需经 RPC（ApiProxy）；`前端` = localStorage 本地项，不经 RPC。
- **读/写**：R = 只读展示；RW = 可改。写项额外标注生效方式。
- **生效方式**：`即时` / `下个请求边界`（agent/request waterfall 或重建 agent）/ `重启 boot`（插件 Config 只能 fiber.update() 重启该插件或重启进程）。
- **透出成本**：`零`（describe 已返回）/ `契约加法`（apiproxy 加方法/字段，host 侧只读现有服务）/ `core 改动`（要动 boot/loop/插件本体）。

## A. host 身份与运行环境（现状 describe 已有/近似有）

| # | 配置项 | 现状来源 | 读/写 | 生效 | 敏感度 | 透出成本 | 建议 |
|---|--------|----------|-------|------|--------|----------|------|
| A1 | host 版本 version | `packages/host/runtime/src/api-proxy.ts:205`（硬编码 '0.0.1'，TODO 读 apps/dsc package.json） | R | — | 低 | 零（字段已在 describe） | 一期 |
| A2 | 工作目录 cwd | `api-proxy.ts:206`（process.cwd()） | R | — | 低（暴露服务器路径，LAN 部署可接受） | 零 | 一期 |
| A3 | 默认 provider/model | `boot.ts:53-56` HostDefaults → `api-proxy.ts:207-208` | R（写见 C2） | — | 低 | 零 | 一期 |
| A4 | 已附着会话数 attachedSessions | `api-proxy.ts:209`（ctx.agents.list().length） | R | — | 低 | 零 | 一期 |
| A5 | 持久化根 persistenceRoot | `apps/dsc/src/web.ts:25` 硬编码 `'./.sessions'`；jsonl Config.root `packages/session-persistence/session-persistence-jsonl/src/index.ts:24-31` | R | 改=重启 boot | 低 | 契约加法（describe 加字段；boot 时把值传给 proxy） | 一期（只读） |
| A6 | 监听端口 port | `apps/dsc/src/web.ts:15`（--port，默认 3080） | R | 改=重启进程 | 低 | 契约加法（同 A5，需 shell 把 port 传进 host——目前 webserver 与 host 互不相知，`packages/host/webserver/src/index.ts:15-22`） | 二期 |
| A7 | node 版本/pid/启动时刻 uptime | process 全局，无现成透出 | R | — | 低 | 契约加法 | 二期（诊断用） |
| A8 | .env 加载状态（加载了哪个 .env） | `packages/ui/app-boot/src/index.ts:40-52`（loadEnv 只留 stderr 痕迹，不留状态） | R | — | 中（路径泄露） | core 改动（loadEnv 得返回并保存结果） | 二期/不透 |

## B. LLM Provider / 模型面

| # | 配置项 | 现状来源 | 读/写 | 生效 | 敏感度 | 透出成本 | 建议 |
|---|--------|----------|-------|------|--------|----------|------|
| B1 | 已注册 provider 列表 | `packages/llm/llm/src/index.ts:143-145` LlmService.listProviders()（id+name，已 detach） | R | — | 低 | 契约加法（host.providers 或 describe 扩展） | 一期 |
| B2 | 各 provider 可用模型目录 | `llm/src/index.ts:153-178` listModels()（advisory 目录）；DeepSeek 目录默认 V4 Flash/Pro `packages/llm/llm-deepseek/src/index.ts:22-25`，yml 可配 models | R | — | 低 | 契约加法 | 一期（模型切换下拉的数据源） |
| B3 | API key | `llm-deepseek/src/index.ts:82-84`（Config.apiKey ?? $DEEPSEEK_API_KEY，缺失则插件加载即 throw）；构造后闭包封存 `adapter.ts:65,90`（仅用于 authorization 头） | R=只报「已配置」；W=重启级 | 改=fiber.update() 重启 llm-deepseek 插件或重启进程 | **高**。key 不回流：adapter 无 getter，透出「已配置 + 末四位」也要 core 改动（新增暴露面）。业界惯例（opencode toPublicInfo 同样过滤）只展示存在性 | 展示存在性=契约加法+core 小改；改 key=core 改动 | 一期只透「已配置/未配置」布尔；改 key 二期或不做 |
| B4 | baseURL | `llm-deepseek/src/index.ts:86`（Config.baseURL ?? $DEEPSEEK_BASE_URL ?? 公网默认 `:61`） | R | 改=重启插件 | 中（内网端点地址） | 同 B3（闭包封存，透出需插件暴露） | 二期（脱敏显示 host 部分） |
| B5 | thinking / reasoningEffort 默认 | `llm-deepseek/src/index.ts:38-41` Config（省略=不上 wire，provider 默认） | R；W=重启插件 | 重启插件 | 低 | 契约加法（读）；写=core 改动 | 二期 |
| B6 | token 用量/上下文水位 | `packages/llm/token-meter/src/index.ts:106+` TokenMeterService.measure()（bootHost 未挂此插件） | R | — | 低 | core 改动（先挂插件）+契约加法 | 二期（属会话页而非 Settings，列此备查） |

## C. 会话/Agent 运行时面

| # | 配置项 | 现状来源 | 读/写 | 生效 | 敏感度 | 透出成本 | 建议 |
|---|--------|----------|-------|------|--------|----------|------|
| C1 | 会话列表/状态 | sessions.list `api-proxy.ts:144-151` | R | — | 低 | 零（已有，属会话页） | — |
| C2 | **运行时切默认 provider/model** | defaults 是 bootHost 返回的普通对象 `boot.ts:53-56`，proxy 闭包引用 `api-proxy.ts:121`（agentOptions 在 createApiProxy 时固化——改 defaults 不影响已建的 agentOptions 对象） | RW | 新会话即时（须把 agentOptions 改为逐次读 defaults）；已开会话=下个请求边界走 `agent/request` waterfall（`packages/core/agent-loop/src/loop.ts:588-596`：每步 seed 自 AgentOptions/logged header，waterfall 可替换且记录进 session log，满足「model-visible ⟺ logged」） | 低 | 契约加法（host.setDefaults）+ core 小改（defaults 可变化 + agentOptions 引用化）；per-session 切换则要挂一个 agent/request waterfall 插件 | **一期首选写项**（host 级默认切换）；per-session 二期 |
| C3 | 每会话 provider/model 覆盖 | AgentOptions `packages/core/agent/src/types.ts:21-26`；create 契约只收 cwd `packages/host/apiproxy/src/api/sessions.ts:41` | RW | 建会话时指定=即时 | 低 | 契约加法（create 加 provider?/model?，恰与 AgentOptions 同形） | 一期可顺手（create 透传） |
| C4 | maxParallelToolCalls | `packages/core/agent-loop/src/index.ts:369-375` Config | R；W=重启插件 | fiber.update() 重启 agent-loop（会打断在跑 agent，代价高） | 低 | 契约加法（读）；写不建议 | 二期只读 |
| C5 | bash 执行参数（cwd/timeoutMs/maxTimeoutMs/maxOutputBytes/graceMs） | `packages/bash/bash-local/src/index.ts:17-29` Config | R；W=重启插件 | 重启 bash-local | 中（暴露执行器边界） | 契约加法（读） | 二期只读 |
| C6 | 系统提示 persona/toolOrder | `packages/core/system-prompt/src/index.ts:143-156` Config（bootHost 传 persona:'' `boot.ts:45`） | R；W=重启插件 | 重启 system-prompt 插件（对新 assembly 生效） | 低 | 契约加法（读）；写=core 改动 | 二期 |

## D. 插件/服务可观测面（Cordis registry）

| # | 配置项 | 现状来源 | 读/写 | 生效 | 敏感度 | 透出成本 | 建议 |
|---|--------|----------|-------|------|--------|----------|------|
| D1 | 已加载插件列表+生命周期状态 | registry 可枚举：`vendor/cordis/src/registry.ts:269-290`（keys/values/entries/forEach，每 runtime 带 fibers）；fiber.state 六态 `vendor/cordis/src/fiber.ts:146`；**现成渲染器** describePlugins `packages/cordis/tool-cordis/src/inspect.ts:66-74`（flat 列表 + pending/loading/active/failed/disposed/unloading 标签，STATE_LABELS `fiber-state.ts:24-31`） | R | — | 低 | 契约加法（host.plugins；host 侧纯复用 tool-cordis 的枚举逻辑或平移其实现——注意 tool-cordis 是模型面工具包，直接依赖它要评估） | **一期**（用户点名项，且成本最低的「亮眼」项） |
| D2 | 已提供服务列表+归属 fiber | describeServices `inspect.ts:50-56`（ctx.reflect.store 枚举） | R | — | 低 | 同 D1 | 一期可并入 D1 面板 |
| D3 | 已注册模型工具列表 | describeTools `inspect.ts:84-86`（ctx.tools.schemas()） | R | — | 低 | 同 D1 | 二期（偏调试） |
| D4 | 插件配置值回显（每插件 Config） | fiber.config `vendor/cordis/src/fiber.ts:188`（validated config 就挂在 fiber 上） | R | — | **高**：config 内可能有 secrets（llm-deepseek Config.apiKey 若走 yml 配置就在里面）——回显必须按 schema 脱敏，schemastery 无现成 redact 标记 | core 改动（脱敏层） | 二期/慎重；一期不透 |
| D5 | 运行时改插件配置 | fiber.update() `vendor/cordis/src/fiber.ts:733-741`（validate→internal/update waterfall→restart） | W | 重启该插件 fiber | 高（任意改配置=任意代码差一步） | core 改动 + 授权设计 | 不透（GUI 不该是 cordis_mount 的平替；自改运行时是 tool-cordis/demo:cordis 的赛道） |
| D6 | 插件失败详情（FAILED fiber 的 error） | fiber._error 私有，状态可见（D1 已含 failed 标签） | R | — | 中（堆栈泄露路径） | 契约加法（fiber.state 公开可读，error 细节需评估公开面） | 二期 |

## E. 纯前端本地项（不经 RPC，localStorage）

| # | 配置项 | 现状来源 | 读/写 | 生效 | 敏感度 | 透出成本 | 建议 |
|---|--------|----------|-------|------|--------|----------|------|
| E1 | 深色模式 | `packages/client/web-ui/src/utils/theme.ts`（'dsc.theme'，源码注释已预告「Settings 页零逻辑迁移按钮」） | RW | 即时 | 无 | 零 | 一期 |
| E2 | 语言 | 无现状（UI 现为单语） | RW | 即时/刷新 | 无 | 零（纯前端） | 二期（i18n 落地时） |
| E3 | 面板偏好（RPC 调试面板开关、列表密度等） | RPC 面板已存在（web-runtime rpc-log.ts） | RW | 即时 | 无 | 零 | 一期低垂 |
| E4 | 连接目标/自动重连策略 | connection.ts 固定同源 | RW | 即时 | 无 | 零（纯前端） | 二期（多 host 需求出现再说） |

## 横切结论

1. **describe 是现成的只读 Settings 数据源**（A1–A4 零成本），`packages/host/apiproxy/src/api/host.ts:17-23` 注释明言「extend in place when fields arrive」——一期只读面就是给 describe 加字段。
2. **唯一顺手的「写」是 C2 host 默认 provider/model**：数据源（B1/B2 枚举）、生效通道（agent/request waterfall 逐请求 seed）、记录面（request header 进 session log）全部现成，缺的只是一个 setDefaults 方法 + defaults 的可变化。
3. **API key 永不回流明文**。现实现连「末四位」都拿不到（构造后闭包封存，无读取面），一期只透「已配置」布尔即可，这与 opencode toPublicInfo 过滤 secrets 的先例一致（`opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:24-31`）。
4. **插件 Config 类可改项全是「重启该插件」级生效**（fiber.update 语义），Settings 一期不碰写，只做只读回显且不回显 config 值本身（D4 脱敏未解决前）。
5. opencode 先例形态：`GET /config` + `PATCH /config`（写后标记 instance 待重建）+ `GET /config/providers`（脱敏后的 provider+models+默认模型）。对应到本仓即 describe 扩展 + setDefaults + providers 枚举，方向一致。

## 建议的一期 Settings 最小集

| 分区 | 内容 | 成本 |
|------|------|------|
| 外观（前端） | 深色模式开关（E1，迁移现有按钮）；RPC 面板开关（E3） | 零 |
| Host 信息（只读） | version/cwd/attachedSessions（A1/A2/A4）+ persistenceRoot（A5，describe 加一字段） | 零～极小 |
| 模型（读+唯一写项） | provider/模型下拉（B1/B2 枚举）+ 切换 host 默认（C2 setDefaults，新会话生效；标注「已开会话下个请求边界生效」）；API key 状态徽标「已配置 ✓」（B3，不回显） | 契约加法为主 |
| 插件（只读） | 已加载插件+状态列表（D1，复用 tool-cordis describePlugins 的枚举逻辑），可并列服务列表（D2） | 契约加法 |

二期候选：C3 每会话覆盖、B4/B5 端点与 thinking 回显、C4/C5/C6 插件参数只读回显、D6 失败详情、A6/A7 诊断。建议不透：D5 运行时改配置、D4 未脱敏的 config 回显、B3 明文 key。
