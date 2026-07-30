# Agent Note：请求级 LLM 配置与凭据 seam

Status: implemented

[English](2026-07-29-request-level-llm-config-credentials.md) | 中文

> 范围：`ctx.settings` 的第一批生产消费方（两个 LLM 适配器插件）与 `packages/credentials/` 能力族。后续的[只读凭据与静态路由](../simplification/2026-07-31-read-only-credentials-and-static-llm-routes.md)决策移除了超前加入的凭据变更、atomic-write 抽取与 settings 驱动的路由生命周期；本 note 负责保留至今的请求解析理由。

## 问题

[settings seam](2026-07-28-user-settings-seam.md) 落地时没有生产消费方，而 LLM 适配器正是当初驱动该 seam 的那个消费方：两个适配器都在插件加载时把 `apiKey`/`baseURL`/catalog 冻结进适配器实例，改密钥或端点就要重启进程，密钥缺失则直接使插件加载失败——对个人配置页而言，这是最糟糕的首次运行姿态（「先存密钥，再重启」）。机密的走向也不对：顺理成章的做法（把 `apiKey` 放进设置文档）会被迫引入脱敏、`replace` 时的服务端回填与 dotfiles 同步告警，为一个同类产品根本没有的问题堆起一整摞缓解措施——Codex（`env_key` + auth.json）、Reasonix（`api_key_env` + 家目录 `.env`）、OpenCode/Pi（`auth.json`）、Claude Code（`apiKeyHelper`）全都把机密挡在配置文件之外。

## 决策

**按请求解析，而非重建 fiber。**适配器接收 options thunk 与按流调用的凭据解析器，不再重建其 fiber。连接、凭据与请求传输事实在操作期间读取，进行中的流则保持其起始事实。密钥缺失会在请求时以 `MISSING_CREDENTIAL` 失败，同时路由保持注册。提供方路由及其重试策略由组合固定，不触发注册替换。

**机密是引用，值藏在 `ctx.credentials` 背后。**配置可以携带 `apiKeyEnv: DEEPSEEK_API_KEY`；只读凭据 seam 按操作解析它。`credentials-local` 先检查活跃进程环境，再按需解析 `$DSH_HOME/.env`，既不缓存，也不提供变更接口。适配器内的解析顺序为：非空的字面 `apiKey` 优先，然后是 seam，最后仅在未挂载 seam 时读取点名的原始环境变量。

**按插件划分 namespace，schema ≡ `Config`。**每个适配器注册自己的 namespace（`llm-deepseek`、`llm-pi-ai`），采用其插件 `Config` schema，并以 `cordis.yml` 配置项为组合 `base`。`resolveAdapterOptions` 与 `resolveProfiles` 仍是显式校验步骤；错误的存活快照会保留最后可用的请求事实，错误的 entry 配置则会加载失败。pi-ai 的 `providers` 是以组合所拥有路由为键的非空字典；用户层可以覆盖这些路由的请求事实，但不能新增或移除路由。

## 曾考虑的替代方案

- **由桥接插件（`dsh-llm-models`）持有统一的 `models` 字典**——有了按插件划分的 namespace，就没有什么可桥接的了；它所需的适配器映射规则纯属凭空发明的间接层。
- **把机密放进 settings.yaml 并靠 `role('secret')` 脱敏**——删除问题本身（引用）胜过缓解问题（脱敏 + 回填 + 同步告警）；编码 agent 同类产品在这一点上口径一致。
- **注册表级的实时重试策略**：让 `providerRetryPolicy` 每次调用都重读，会静默改变所有注册都依赖的 `ctx.llm` 捕获契约；因此，重试策略与组合所拥有的路由一同保持固定。

## 后果

无密钥启动仍然有效：第一次请求会失败并点名该引用，而从外部提供的环境变量或 dotenv 值无需重启即可作用于下一次请求。demo 默认挂载 `settings-local` 与只读的 `credentials-local` 提供方，不内联任何 `!!js` 密钥接线。在当前消费方为其契约提供依据之前，凭据管理 RPC／UI 与注册变更均不存在。settings 层的数组仍整体替换，pi-ai 提供方路由也仍由组合决定。[凭据边界 note](2026-07-30-credential-boundaries-and-atomic-registration.md)负责保留至今的存储与请求世代安全决策。
