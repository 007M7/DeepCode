# Agent Note: pi-ai 路由是被声明的提供方，而不是 catalog 查表

Status: implemented

[English](2026-08-03-pi-ai-declared-provider-catalog.md) | 中文

## Problem

`dsh-llm-pi-ai` 把 pi-ai 包生成的 catalog 当成了可配置范围的边界。路由键必须点名一个已安装提供方（`resolveProfiles` 拒绝其余一切），模型列举原样返回 `getBuiltinModels(provider)`，请求期的模型解析又在同一份 catalog 里查这个 id、且只覆盖 `baseURL`。由此产生三个后果，而且三个都是死路而非缺口：OpenAI 兼容网关、自建服务，或比已安装 catalog 更新的提供方，根本无法配置；catalog 尚未跟上的模型即便端点正确也会以 `UNKNOWN_MODEL` 失败；模型的上下文窗口与输出上限完全由锁定的 pi-ai 版本决定，部署既无法更正过期值，也无法为 pi-ai 从未描述过的模型补上。要动其中任何一条，只能升级依赖。

适配器还经 `@earendil-works/pi-ai/compat` 的 `streamSimple` 发起流式请求，而该入口自己的模块文档声明它是临时兼容面——其 catalog 读取标了 `@deprecated`，并会在 pi-ai 完成 `ModelManager` 迁移时被删除。这三条配置限制与这个废弃依赖的解法是同一个，因为 pi-ai 受支持的运行时（`createModels()` / `createProvider()`）正是围绕「提供方是被*声明*出来的，而非查出来的」建立的。

## Decision

提供方路由是一份**声明**，已安装 catalog 是它的默认值。`resolveProfiles` 不再拿路由键去核对 `getBuiltinProviders()`，而是把每条路由解析成一份物化模型列表，外加服务它的 pi-ai `Provider`：

- `catalog.ts` 把已安装 catalog 合并到 profile 自身条目之下。profile 的 `models` 列表*替换*该路由的 catalog（列表缺席或为空则原样服务），每个条目从同 `id` 的已安装模型继承自身未设置的字段。只有 harness 会消费的字段可配置——`id`、`name`、`contextWindow`、`maxTokens`、`reasoning`。定价与输入模态不出现在配置面，因为没有任何读取方：`replay.ts` 把 pi-ai 的成本元数据清零，`context.ts` 只保留文本块。思考级别拼写、OpenAI 兼容性怪癖与模型标头沿用已安装条目，因为在配置里重述它们无法被校验。
- `provider.ts` 构造路由的 `Provider`。保持 catalog 协议不变的 catalog 路由会**复用**已安装提供方，只替换 `getModels()`；其余路由都由 `createProvider()` 基于一张协议表构造，表中条目正是 pi-ai 自己的提供方工厂所用的 `@earendil-works/pi-ai/api/*.lazy` factory。
- `adapter.ts` 持有一个 `createModels()` 集合，在解析产出新的 profile 映射时重新同步，并由它服务 `listModels`、`resolveModel` 与 `stream`。模型已配置的 `maxTokens` 会成为 seam 的 `defaultMaxTokens`，因此未点名输出上限的请求现在会携带已配置的那一个。

解析失败得响亮，并点名出问题的路由与模型：catalog 未描述的模型需要显式的 `contextWindow` 与 `maxTokens`；catalog 未提供的路由需要 `api`、`baseURL` 和非空的 `models` 列表。由于构造出的 `Provider` 是解析结果的一部分，协议或模型出错时最后可用的路由集合会继续服务——与此前坏的 settings 快照的行为完全一致。

可配置提供方目录现在是已安装 catalog **与**当前 profile 声明的每条路由的并集，并在该集合变化时重新登记。没有这个并集，手工声明的路由就没有 settings 地址，任何配置界面都无法展示或编辑它。

### 凭据留在 pi-ai 之外

pi-ai 的 `Models` 自带一套凭据概念——按提供方 id 索引的 `CredentialStore`，配合 `envApiKeyAuth` 解析 `credential.key ?? env(VAR)`。采用它会在 `ctx.credentials` 之外制造第二个凭据事实源，更糟的是会把 harness 明确禁止的环境回落重新引进来：点名了却取不到的 `apiKeyEnv` 必须以 `MISSING_CREDENTIAL` 失败，而不是用环境里恰好持有的某个无关密钥完成认证。

`ModelsImpl.applyAuth` 把 `options.apiKey` 视为优先级最高的 auth 覆盖，会整条短路掉解析。因此 harness 一如既往经自身 seam 解析路由密钥，并把结果作为请求的 `apiKey` 传入；该集合构造时不带任何凭据存储。catalog 路由复用已安装提供方的 `auth`，从而为不点名凭据的 profile 保住其提供方原生环境发现。手工声明的路由则获得一个 harness 自有的 `ApiKeyAuth`，它报告「已配置但无密钥」而非「未配置」，把该要求留给协议——那才是它真正所在的位置：pi-ai 的 OpenAI 兼容实现仍要求密钥或 `Authorization` 标头，并且会自己说出来。

## Alternatives considered

- **保留 `createProvider()` 但不建 `Models` 集合**，改由 `provider.streamSimple(model, ctx, {apiKey})` 发起。改动最小且凭据路径原封不动，但 `createProvider` 的 `auth` 是必填字段，这条路上它永远不会被调用——一份因签名而必填、却没有调用方的实现。它还让 `refreshModels` 需要手工构造 `RefreshModelsContext`，并使适配器始终不在 pi-ai 真正支持的运行时上。
- **catalog 路由复用已安装提供方，只有声明式路由走 `createProvider()`**，且两者不共享解析。对 catalog 行为零风险，但 catalog 物化、端点覆盖与每模型配置这三件事都要各写两遍，而改指协议的 catalog 路由还得在解析中途跳到另一条路径。已采纳的拆法把不对称收敛在提供方构造这一处——那里的不对称是 pi-ai 不暴露已构造提供方的 API 实现所强加的。
- **让每条路由都经 `createProvider()` 重建**，包括 catalog 路由。完全对称，但已构造的 `Provider` 不暴露自己的 `api`，于是协议表会成为「哪些提供方能用」的天花板——Bedrock 经独立入口加载其 Smithy 模块，会因此静默失效。
- **完整暴露 pi-ai 的 `Model` 形状**（成本、输入模态、`thinkingLevelMap`、`compat`）。可配置性最大，但这些字段当前没有任何读取方，因此配了价格或模态什么也不会改变，却看起来像是受支持的。
- **运行时动态 catalog**——`fetchModels` 加 `ModelsStore`，后台刷新。本次变更拒绝：它把模型列表变成需要缓存、失效与离线路径的外部可变状态，而产品需求是一次性的发现动作、其结果由用户采纳进 `settings.yaml`。该动作属于配置界面，与之一并暂缓；`settings.yaml` 始终是「路由服务什么」的唯一事实源。

## Consequences

配置一个提供方不再取决于 pi-ai 的发布节奏。网关、自建服务，或比锁定 catalog 更新的模型，都是一次 `settings.yaml` 编辑，过期的上下文窗口也能就地更正。废弃的 `/compat` 导入已经消失，因此 pi-ai 删除它不再是破坏性事件。`defaultMaxTokens` 现在自配置流出，堵上了「请求完全不带输出上限」的情形。

代价是：声明式路由会让 `settings.yaml` 变长，因为 catalog 无法默认的模型必须自报容量。`api` 作用于整条路由，因此混合协议的 catalog 路由无法承载另一种协议的模型——把它拆成两个路由键是变通办法。没有任何环节查询提供方的 `/models`，因此模型列表的新鲜度只到最近一次编辑为止。有一种情形下报错形状发生变化：auth 解析不出任何值的路由，现在会在任何网络调用之前把 pi-ai 自己的诊断作为错误 `finish` 分片呈现，而此前的适配器会发出无密钥请求并呈现提供方的 401。

## Testing

`tests/catalog.spec.ts` 针对本地 mock 服务器端到端覆盖该契约：手工声明的路由带着自己的凭据流向自己的端点、它在可配置提供方目录中的出现、每模型覆盖从已安装 catalog 继承默认值、向 catalog 路由添加模型、带与不带端点覆盖的协议改指、catalog 独有元数据在覆盖后存活、无密钥姿态及其 `Authorization` 标头变通，以及每一种点名路由或模型的解析失败。`tests/sdk-options.spec.ts` 把 SDK 边界从已移除的 `/compat` 导入改指到协议表的 lazy api 模块，同时钉住「setup 失败以终止性错误分片而非抛出的形式抵达」。twin 的[设计验证角色](2026-06-13-twin-llm-adapters.md)不变。
