# Agent Note：web 配置平面

Status: implemented

[English](2026-07-30-web-config-plane.md) | 中文

> 范围：[请求级 LLM 配置 note](2026-07-29-request-level-llm-config-credentials.md) 中延后的 wire 面与 web UI——带推送式失效的 `settings.*`/`credentials.*`/`llm.*` RPC 领域、分层且脱敏的 `describe()`、llm 可配置提供方目录与拓扑事件、独立的 `dsh-client-schema-form` 模型层，以及带手写提供方编辑器的 Models 设置页。`deepseek` → `deepseek-official` 提供方路由重命名作为解锁前提的破坏性变更一并搭车合入。

## 问题

PR1 让 LLM（大语言模型）适配器配置在 seam 层面免重启，但唯一的写入方还是直接编辑 `settings.yaml` 的文本编辑器：web 客户端没有触达设置、凭据或提供方拓扑的任何 wire 通道，「存入密钥、再次发起提示」于是仍意味着离开产品本身。挡住配置页的缺口不是一个，而是三个：`describe()` 只返回合并后的生效值（表单分不清用户覆盖与组合默认值，而且照原样序列化会把 `role('secret')` 的值发到每一个浏览器）；没有任何东西枚举适配器*可以*运行的提供方（裸挂载的 `llm-pi-ai` 在配置之前完全不可见）；两个适配器又都想要 `deepseek` 这个路由键，目录因此无法无歧义地把路由归到拥有它的 namespace 名下。为每个提供方手工维护一份表单被直接否决——schema 已经以 schemastery `Config` 值的形式存在，第二份字段真源注定漂移。

## 决策

**wire 领域挂上编译期 RPC 映射，拒绝落为错误码，失效落为帧。**`settings.describe/update/replace`、`credentials.describe/set/unset`、`llm.providers` 与 `llm.models`（认领预留的 `host.listModels` 面）一同加入 `RpcMethodMap`，七处由编译器锁定的接线位点因此让契约、schema、处理器与客户端保持步调一致。seam 侧的拒绝折叠为 `settings-rejected {ns}`/`credential-rejected {ref}` 业务错误（HTTP 仍只是载体），三个 `HostFrame`——`host/settings-changed {ns}`、`host/credentials-changed {ref}`、`host/models-changed`——沿用 `host/commands-changed` 的形状，因此每个客户端都无需轮询即可收敛。写入与 `pickDirectory`/`openPath` 一起进入连接守卫的特权集合：回环 + 同源，否则 403，因为暴露在局域网上的 dsh web 绝不能接受来自其他源的配置修改。

**`describe()` 增加分层与结构化 secret 脱敏。**`SettingsDescriptor` 在生效值之外携带 `base`/`user`，表单据此按「字段是否出现在用户层」来标记「已覆盖」，而非按值是否不等（与 base *相等*的覆盖仍然是覆盖）。`describe({ redactSecrets: true })`——在每个 wire 面都强制启用——经由对 schema 的纯结构遍历（object/dict/array 容器；secret 角色子树整体是一个不透明叶节点）从全部三层剥除 `role('secret')` 子树，并把剥除的槽位枚举为 `{path, set}`，页面因此不必收到任何值就能渲染只写输入框。

**llm seam 声明可配置性并公布拓扑。**`registerConfigurableProviders()` 是一个全有或全无、以 fiber 为作用域的目录，条目为 `{provider, displayName, settingsNs, settingsPath}`——这正是配置页要为一条可能尚不存在的路由打开正确设置子树时所需要的寻址；`listConfigurableProviders()` 在 wire 处理器里与存活路由合并，未声明的存活路由因此仍报告为激活。零负载的 `'llm/adapters-updated'` 事件从全部四个注册／注销提交点触发，listener 派发带异常隔离（INVARIANT 重抛），沿用 settings/commands 的先例。`llm-deepseek` 的路由重命名为 `deepseek-official`，因为 pi-ai catalog 名正言顺地拥有 `deepseek` 这个聚合器条目；依预发布立场，不设别名。

**架在 schema 模型层之上的手写编辑器。**`dsh-client-schema-form` 把 wire 的 `toJSON()` 信封还原（rehydrate）为活的 schemastery 节点，用于校验、路径解析与不可变草稿编辑——但不做通用渲染：第一版交付了完整的 schema 驱动表单渲染器，得到的却是一个未加样式、把 schema 原样倾倒出来的页面（每个进阶字段都平铺到卡片上、原始字段名直接充当标签、`retryPolicy` 的「不支持」回退落在主流程里）。用户没有再加一套提示／分组系统，而是选择了手写方向，第二轮又把引用输入框整个移除：卡片的主字段是一个 **API 密钥**输入框，未配置密钥的整分节提供方会以其设置卡片的形式打开，收起的「自定义设置」折叠区承载按家族精选的额外字段（两个家族都有 `baseURL`，另加 deepseek 的 `reasoningEffort`／pi-ai 的 `reasoning`），其余每个字段都归 `settings.yaml` 所有。校验仍会在写入前运行还原出的 schema，因此偏离其 schema 的手写字段会在保存时大声失败，而非静默失败。

**Models 页是一次三领域联接，应用语义与 seam 同形。**每一行是一个已配置的提供方；「新增」卡片的选择框是可配置提供方目录中剩余的休眠条目；徽标来自路由存活状态。密钥通道保持引用形态，却从不展示任何引用：键入的密钥经 `credentials.set` **只写**存入 profile 的 `apiKeyEnv` 之下，引用不存在时便派生 `<ROUTE>_API_KEY`（pi-ai profile 会记录该派生），因此 `settings.yaml` 从不携带密钥值，删除所需的整体 `settings.replace` 也绝不可能丢掉兄弟条目的机密。不含删除的编辑以一次最小的 `settings.update` 合并 patch 落地；把折叠区字段清回继承值或删除整行则经 `settings.replace` 替换整个用户分节，因为合并语义表达不了删除。

## 曾考虑的替代方案

- **在 wire 上改发 JSON Schema**——schemastery 的 `toJSON()` 信封能往返保留 `role()`/meta，并还原成客户端为草稿校验本就自带的那个校验器；转换成 JSON Schema 丢掉的恰恰是凭据控件与 secret 脱敏所依赖的角色注解。
- **通用的 schema 驱动表单渲染器**——先实现、后被替换：如实呈现字段却缺失视觉层级，产出的卡片丑陋且不可用；要把它做好，就意味着构建一套提示词汇（主要／进阶分组、逐字段描述、数组项卡片），成本堪比手写编辑器，却仍无法与任何设计稿完全吻合。今天存在两份 schema（deepseek 的 `Config` 与共享的 pi-ai profile），手写因此就是两套以 namespace 为键的薄布局；漂移风险由保存时的 schema 校验以及未知字段在文档中的原样保留共同约束。
- **逐字段脱敏机密并在 `replace` 时回填哨兵值**——PR1 的决策（机密是引用）已经为产品默认形态删掉了「存储字面量」这种情况；结构化脱敏加上只写的凭据通道足以处理残余情形，无需让每个写入方都学会一套哨兵协议。
- **把键入的密钥存成字面 `apiKey` 设置**——v1「单个 API 密钥输入框」的需求本可以把字面量直接写进 profile，但 UI 的每条删除路径都会从*脱敏后的*各层重建用户分节，任何重置或整行删除都会静默丢掉已存储的兄弟密钥；派生引用让输入保持单字段，同时让 `settings.yaml` 不含机密、每一次 replace 都安全。
- **由 `models` 桥接插件持有提供方配置**——与 PR1 相同的否决理由：按插件划分的 namespace 加上四字段的目录声明已经给了 UI 需要的一切；桥接层的统一字典会把适配器映射那层间接重新引进来。
- **页面侧轮询而非推送帧**——mux 已经承载 `host/commands-changed`；再加三个帧各自只多一个形状的成本，就让第二个标签页、外部的 `settings.yaml` 编辑和由设置催生的路由都以事件速度收敛。

## 后果

整条闭环以无密钥方式固定在浏览器测试通道（`apps/web/tests/models-settings.e2e.ts`）：「新增」卡片提供休眠的 pi-ai catalog，携键入的密钥添加 `minimax-cn` 会把只含引用的 profile 写入 `settings.yaml`、把密钥值存入 harness 家目录 `.env` 中派生的 `MINIMAX_CN_API_KEY` 之下、路由随拓扑帧注册为存活，「自定义设置」折叠区则把 `reasoning` 合并到引用旁边——全程零模型调用，「新增」卡片态与已配置态各有 ARIA golden，另有脚手架式的 `harnessHome`，测试绝不触碰真实的 `~/.dsh`（受测提供方是派生引用不可能与开发者已导出密钥相撞的那一个）。这次重命名在一次提交中触及 239 个文件（fixture（测试前置数据）、golden、文档、python），未保留兼容别名。替换渲染器只花了一次提交，且没有任何 wire 变更：应用语义、脱敏与目录联接从一开始就与渲染器无关。延后事项：每行的模型预览（选择器已能列出模型）、为从未声明可配置性的存活路由提供页面地址，以及已记录在案的重置边界情形——`settings.replace` 无法在被替换的子树里重新补上已存储的*字面量*机密，而基于引用的默认形态让这种情况根本无从出现。
