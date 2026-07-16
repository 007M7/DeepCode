# RFC：MCP 客户端插件——连接外部 MCP 服务器并桥接其工具

Status: implemented

[English](2026-07-07-mcp-client-plugin.md) | 中文

## 问题

harness 此前无法消费 MCP（Model Context Protocol）生态的工具。MCP 是工具服务器的新兴标准：GitHub、文件系统、数据库、代码搜索以及数百个社区服务器都通过 MCP 暴露工具。用户希望将 harness 指向一个或多个 MCP 服务器，让它们的工具以原生的模型可见工具形式出现，而无需为每个服务器编写胶水代码。

`ToolRegistry` 已经接受原始 JSON Schema 工具定义（见 `dsh-tools` README："Raw JSON-Schema tool definitions (from MCP servers) are still accepted by `ToolRegistry.register()` directly"），扩展实操手册（cookbook）也勾勒了预期模式（"MCP | one plugin per server: discover tools → `ctx.tools.register()`"）。基础设施已就绪，缺的是桥接插件。

## 决策

### 包

单个包 `@deepseek-ai/dsh-mcp-client`，位于 `packages/mcp/mcp-client/`。不做能力 seam 三包拆分：可预见范围内不会有第二种 MCP 客户端实现，且约定是「不要预防性拆分」（见[能力 seam RFC](../../implemented/architecture/2026-06-13-capability-seams.md)）。

### SDK

使用官方 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)（`Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`）。harness 不自行实现 JSON-RPC，与 ACP 委托给 `@agentclientprotocol/sdk` 的做法一致。

### 范围

仅 MCP 客户端（不含服务器端——ACP 已覆盖「将 harness 暴露为 agent」的角色）。仅桥接 **Tools**：Resources 和 Prompts 推迟（它们需要 harness 侧尚不存在的消费机制，且设计空间很大）。

### 插件形态

命名空间插件（具名导出 `name`/`inject`/`Config`/`apply`，无 `export default`）。`inject: ['tools']`。每个 MCP 服务器在 `cordis.yml` 中是一个插件实例：同一个包以不同配置加载 N 次，与 `dsh-tool-subagent` 相同。

### 配置

以 `transport` 字段为判别的扁平联合类型：

```typescript
interface StdioConfig {
  transport: 'stdio'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number  // default 60_000
}

interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number  // default 60_000
}

type Config = StdioConfig | StreamableHttpConfig
```

`serverName` 是稳定的本地标识，用于在模型可见名称（见下文）中为该服务器的工具划定命名空间。它有意设计为用户配置，**不是**远端的 `serverInfo.name`：远端名称是不可信输入，跨部署不唯一（同一服务器的 prod 和 staging 实例报告相同名称），且可能在服务器升级时变化——这些都不得静默地重命名模型可见工具。多个活跃实例使用相同 `serverName` 属于配置错误：后加载的实例在启动时以可操作的错误消息失败，绝不静默覆盖或跳过。短 `serverName`（如 `gh`）同时也是缩短公开名称的旋钮。

`cordis.yml` 用法示例：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js `Bearer ${process.env.MCP_TOKEN}`
```

模型看到的是 `mcp__github__create_issue`、`mcp__github__search_code`、`mcp__web__search`。

### 生命周期

启动时从 `cordis.yml` 加载。HMR（`@cordisjs/plugin-hmr`）提供热替换：编辑 yml 条目会触发旧实例的 dispose（断开连接、注销工具），并创建新实例（连接、发现、注册）。目前不提供运行时动态 API。公开名称是 `(serverName, rawName)` 的纯函数，因此保持 `serverName` 不变的 HMR 替换会重建完全相同的模型可见名称——会话历史和权限规则保持有效——且添加或移除一个无关服务器绝不会重命名已有工具。

### 工具发现与注册

每个 MCP 工具有两个名称：

- `rawName`：MCP `Tool.name` 的原始值，仅在协议层（`tools/call`）使用。
- `publicName`：在 `ToolRegistry` 中注册的全局唯一模型可见名称：

      mcp__<serverName>__<rawName>

这种按服务器限定的形式是多服务器 agent 客户端的事实标准：所有被调研的终端用户产品都按服务器限定 MCP 工具（[Claude Code](https://code.claude.com/docs/en/agent-sdk/mcp#tool-naming-convention) `mcp__github__list_issues`、[Codex](https://openai.com/index/unrolling-the-codex-agent-loop/) `mcp__weather__get-forecast`、[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/#3-tool-naming-and-namespaces)、[VS Code](https://github.com/microsoft/vscode/blob/ab9ec62c6a61e429a9abd612ff220c3f4834c9ea/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L217-L260)、[Cline](https://github.com/cline/cline/blob/52fdbb1d72f7324a28142a7ba7678d4b53c902f4/sdk/packages/core/src/extensions/mcp/name-transform.ts#L20-L35)、[Roo Code](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/utils/mcp-name.ts#L117-L140)、[Goose](https://github.com/block/goose/blob/b3a012cbdde854b0fe14f95b1c48543bf6517c0a/crates/goose/src/agents/extension_manager.rs#L1391-L1441)、[OpenCode](https://github.com/anomalyco/opencode/blob/d199b1bff90282a4f9cd6251b5fc7b16875a52f6/packages/opencode/src/mcp/catalog.ts#L117-L120)）；`mcp__<server>__<tool>` 的确切拼写沿用 Claude Code 和 Codex。`mcp__` 前缀将 MCP 注册隔离在原生工具命名空间之外，并为权限/遥测规则提供稳定的匹配形状（`mcp__*`、`mcp__github__*`）。

1. 连接时：遍历 `client.listTools()` 的分页，推导每个工具的 `publicName`，然后通过 `ctx.tools.register()` 将其注册为原始 `ToolDefinition`。MCP 的 JSON Schema 和 description 原样透传（不做 `defineTool` DSL 转换）；仅替换模型可见的 `name`。
2. 监听 `notifications/tools/list_changed` → 重新执行同步（dispose 上一代、注册新一代）。确定性的名称意味着未变化的工具在重新同步后保持原名。
3. 执行器闭包持有 `rawName`；公开名称从不发送给服务器，也从不被解析以恢复原始名称。
4. 不提供 `presentCall`/`presentResult`：ACP 桥接的通用卡片回退负责渲染。
5. 工具在系统提示词中是透明的：除名称本身外不添加 "[via MCP]" 之类的标注。

### 公开名称规范化

MCP 允许工具名最长 128 字符且可包含 `.`；DeepSeek 的函数名契约允许 `[A-Za-z0-9_-]` 且最长 64 字符。公开名称按确定性规则规范化：非法字符替换为 `_`，当替换或截断改变了名称时，追加 `(serverName, rawName)` 标识的 12 位十六进制 SHA-256 hash，确保不同的 MCP 标识永远不会折叠为同一个公开名称：

```typescript
function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = sha256(`${serverName}\0${rawName}`).slice(0, 12)
  return `${normalized.slice(0, 64 - 13)}_${hash}`
}
```

### 名称冲突处理

MCP 仅保证工具名在[单个服务器内](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names)唯一；跨服务器冲突是常态而非例外（一项[微软研究院调研](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/#namespacing-issues-and-naming-ambiguity)覆盖 1,470 个服务器，发现 775 个冲突工具名；仅 `search` 就出现在 32 个服务器中，官方 GitHub 服务器发布的是裸 `create_issue`）。始终启用的命名空间从结构上杜绝冲突，而非在冲突发生时再处理：

- 两个服务器都发布 `search` → 共存为 `mcp__github__search` 和 `mcp__web__search`。
- 名为 `search` 的原生 harness 工具不受影响。
- 重复的 `serverName` 配置导致后加载的实例在启动时失败（见「配置」一节）。
- 同一服务器列出重复的工具名属于无效工具列表：同步抛出异常，上一代注册保持不变。
- 替换期间的注册表冲突只可能意味着外部工具占用了本服务器的 `mcp__<serverName>__` 命名空间：部分生成被回滚（该服务器零工具注册），错误被醒目地记录。

工具永远不会被静默跳过；哪些工具可用永远不取决于插件加载顺序。

### 命名不变式

1. 每个 MCP 工具有稳定标识 `(serverName, rawName)`；每个活跃标识恰好对应一个公开名称。
2. 公开名称是确定性的、全局唯一的，且满足 DeepSeek 64 字符 `[A-Za-z0-9_-]` 契约。
3. MCP `tools/call` 始终接收原始的 raw name。
4. 连接、断开或重新同步一个无关服务器，绝不会重命名已有工具。
5. 注册顺序绝不决定哪个工具可用。

### 工具执行

为来自同一 MCP 服务器的所有工具提供统一的 `execute` 处理器：

1. 解析 `rawName`（执行器闭包持有），以配置的超时调用 `client.callTool({ name: rawName, arguments }, { signal: exec.signal })`——公开名称从不发送给服务器。
2. 映射结果：
   - 多个 `text` 内容块 → 以 `'\n'` 连接为单个 `TextBlock`（必要原因：`flattenText` 使用 `join('')` 不带分隔符，多个块会丢失块间边界）。
   - `image` 内容块 → 丢弃并记录 `ctx.logger.warn`（harness 没有图片内容块类型；见 [drop-image RFC](../../implemented/simplification/2026-07-04-drop-image-content-block.md)）。
   - `isError: true` → 映射到 harness 的 `isError` 结果路径（`{ content: [...], isError: true }`）。
3. 取消：`exec.signal`（来自 agent loop 的 cancel）透传给 MCP SDK 的 `callTool`，后者向服务器发送 `$/cancelRequest`。

### 子进程环境（stdio 传输）

复用 `dsh-subagent-acp` 的 `buildChildEnv` + `SENSITIVE_ENV_PATTERN` 清洗逻辑：过滤环境变量（剥离匹配 `/KEY|SECRET|TOKEN/i` 的凭证形变量），然后将 `config.env` 覆盖在上面。显式配置的 env 不受清洗影响。

### 断开连接 / 崩溃

不自动重连。如果 MCP 服务器进程退出或传输层关闭：

1. effect dispose → 所有已注册工具被注销（fiber 作用域的 disposer）。
2. 后续模型对这些工具的调用 → `ToolNotFoundError` → `isError: true`。
3. 恢复方式：用户编辑 `cordis.yml`（触发 HMR 重载）或重启 harness。

这与 ACP subagent 的模式一致：「崩溃即终态，报告错误，清理资源，不重试。」

## 曾考虑的替代方案

### MCP 服务器端（向外部 MCP 客户端暴露 harness 工具）

推迟。ACP 桥接已将 harness 暴露为 agent 服务器。再加一层 MCP 服务器会用不同协议重复这一功能，而用户的首要需求是消费外部工具，而非暴露自身工具。

### 能力 seam 三包拆分（接口 / 实现 / 消费方）

否决。可预见范围内不会有替代的 MCP 客户端实现：MCP 只有一个协议、一个 SDK。约定是「在第二种实现出现之前不要预防性拆分」。

### 指数退避自动重连

v1 否决。引入复杂性（工具已注册但暂时不可用的部分可用状态），且 stdio 进程崩溃通常表明配置问题，重试无法修复。HMR 已提供手动恢复路径。如有需要，未来可作为 `reconnect: boolean` 配置项加入。

### 桥接 Resources 和 Prompts

推迟。Resources 需要 harness 侧的机制来决定何时注入内容（系统提示词？按需？模型触发？）。Prompts 需要 harness 目前缺少的「prompt 模板」概念。两者都需要独立设计；Tools 是高价值、低风险的起点。

### 原始模型可见工具名加可选 `toolPrefix`

否决。这是最初的提案，建立在「大多数 MCP 服务器已在工具名中使用语义前缀（如 `github_create_issue`）」的前提上。该前提不成立：官方 GitHub 服务器发布的是 `create_issue`，参考文件系统服务器是 `read_file`，Sentry 是 `search_issues`——且上述微软调研表明冲突在生态规模下很常见。冲突时再加前缀（或 warn-and-skip）还会使可用工具集取决于插件加载顺序，且添加一个无关服务器可能静默重命名已有工具——在对话中途使会话历史和权限规则失效。所有被调研的多服务器 agent 产品都不使用裸名称。

### 仅服务器命名空间（`github__create_issue`，无 `mcp__` 前缀）

v1 否决。它能防止跨服务器冲突，但无法将 MCP 注册与原生 harness 工具隔离，也放弃了 MCP 全局策略匹配形状（`mcp__*`）。前缀仅消耗 5 个字符；`mcp__<server>__<tool>` 的拼写与 Claude Code 和 Codex 一致，最大化模型的熟悉度。如果 ToolRegistry 将来增加源感知的命名空间，届时可作为命名策略变更重新考虑去掉字面前缀。

### 从服务器公告的 `serverInfo.name` 推导命名空间

否决。远端名称不可信、跨部署不唯一、升级时可变；工具标识和权限规则不得静默跟随它。命名空间是本地配置。

### 在工具结果中保留多个 TextBlock

否决。DeepSeek 序列化器中的 `flattenText()` 在将 `ContentBlock[]` 展平为协议格式（wire format）时使用 `join('')`（无分隔符）。多个 text 块会静默丢失块间边界——这是正确性 bug。所有现有工具返回单个 TextBlock；MCP 桥接遵循同样做法。

## 测试

覆盖按层级命名；每个行为放在能表达它的最低成本层级。

- **单元测试**（`tests/mcp-client.spec.ts`、`tests/apply.spec.ts`，mock MCP SDK）：`publicToolName` 算法（干净路径、规范化、截断加 hash、确定性、不同标识的分离）、raw 与 public 的协议纪律、跨服务器与原生工具共存、重复 `serverName` 加载失败与预留释放、无效工具列表拒绝、代际替换/回滚、重新同步失败时的保留、结果映射、取消、配置 schema 校验。100% 逐文件覆盖率门禁约束该包。
- **E2E**（`tests/mcp-client.e2e.ts`，无需密钥）：使用仓库内 fixture 服务器、`@modelcontextprotocol/server-everything` 和 `@modelcontextprotocol/server-filesystem` 通过 stdio 运行真实 MCP 协议，以及通过进程内 `StreamableHTTPServerTransport` 服务器运行 Streamable HTTP——命名空间下的发现、带点号名称的端到端规范化、执行往返、重复 `serverName` 拒绝、dispose（资源释放）。
- **快照**：刻意不做。MCP 工具不引入新的 transcript 渲染面——它们注册为原始 `ToolDefinition`，通过 ACP 桥接的通用卡片回退渲染，而桥接的单元测试套件已固定了该行为（`packages/ui/acp/tests/stream-update.spec.ts`）。将 MCP 服务器加入快照示例的 `cordis.yml` 会改变已固定的 `text-turn` 系统提示词 fixture（迫使每条录制的 golden 都需要带密钥重新录制），并使每次回放依赖于 spawn 一个外部 MCP 服务器进程——而新增的渲染行为为零。如果后续变更为 MCP 工具引入专属的渲染意图，该变更届时自行命名其快照覆盖。

## 后果

- 每个 MCP 服务器只需一条 `cordis.yml` 条目即完成集成：`serverName: filesystem` 加一条 stdio 命令（或一个 Streamable HTTP URL），就能把 `mcp__filesystem__read_file` 放入模型的工具列表，可调用，协议层使用原始的 `read_file`。
- 公开名称是会话历史与权限/配置界面的一部分；命名算法是由测试固定的 v1 契约，发布后修改它是破坏性变更。
- `mcp__<serverName>__` 限定符在每个名称上消耗 token。已接受：description 和 JSON Schema 在工具定义 token 中占主导，而限定符换来了稳定标识、冲突隔离和 MCP 全局策略匹配形状（`mcp__*`、`mcp__github__*`）。
- **MCP SDK 稳定性**：`@modelcontextprotocol/sdk` 仍在演进；破坏性变更需要更新桥接。版本已固定，且该 SDK 被广泛采用（Claude Desktop、Cursor、VS Code），因此破坏性变更不太可能悄然发生。
- **工具 schema 质量**：MCP 服务器可能暴露描述不佳的工具（模糊的 description、不完整的 JSON Schema）。harness 原样透传——垃圾进垃圾出；这是服务器作者的责任，不是桥接的责任。
- **Stdio 进程管理**：行为异常的 MCP 服务器如果忽略信号可能卡住 dispose。Cordis fiber 的 dispose 有有界静默期；卡住的传输层最终会在框架层面超时。
- 崩溃恢复是手动的（HMR 编辑或重启）——v1 已接受；`reconnect` 配置项作为未来工作保持开放。
