# 配置文件

Harness 使用 `cordis.yml` 描述一个 Agent 加载哪些插件、以什么参数运行。

## 从例子开始

### echo-agent 的配置

这是一开始的第一个 Agent 的完整配置：

```yaml
# 热替换：修改代码后自动重载，不用手动重启
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root: ['.']

# Mock 模型：从本地 `.ts` 文件加载，注册一个名为 `mock-llm` 的工具
# 本地模拟 LLM 响应，不联网
- id: mock-llm
  name: './src/mock-llm.ts'

# Echo 工具：收到文本后转大写返回
- id: echo-tool
  name: './src/echo-tool.ts'

# Bash 执行器：从 npm 包 `@deepseek-ai/dsh-bash-local`加载，提供 bash 命令执行能力
- id: bash
  name: '@deepseek-ai/dsh-bash-local'

# 应用主体：把 session 管理、tool 调度、agent loop 等组装成一个可交互的终端 Agent
# 只需告诉它用哪个模型 (`model`)、什么人设 (`persona`)
- id: stdio-agent
  name: '@deepseek-ai/dsh-stdio-demo'
  config:
    model: mock-echo
    persona: 'You are echo-agent, a demo agent.'
    welcome: 'echo-agent ready. Type a message ("echo <text>" triggers the tool).'
    persistenceRoot: './.sessions'
```

### repl-agent 的配置

真实场景——接入 DeepSeek API，带完整工具链：

```yaml
# 热替换：同上，开发时自动重载
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root: ['.']

# LLM 后端：从 npm 包加载，具备接入 DeepSeek API 能力
# `!!js` 从环境变量读取密钥，不会写进配置文件
# `models` 声明该适配器能处理哪些模型名
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    baseURL: !!js process.env.DEEPSEEK_BASE_URL
    models:
      - deepseek-v4-pro
      - deepseek-v4-flash

# Bash 执行器：让 Agent 能跑 shell 命令
# timeoutMs 设置单条命令的超时时间
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    timeoutMs: 60000

# 应用主体：和 echo-agent 一样的框架，只是配置不同
# `model` 指定默认使用哪个模型（要和上面 models 列表里的名字对应）
# `persona` 是系统提示词，{{model}} 会被替换为实际模型名
# `resumeSessionId` 设了就恢复旧对话，没设就每次新建
- id: stdio-agent
  name: '@deepseek-ai/dsh-stdio-demo'
  config:
    model: deepseek-v4-flash
    resumeSessionId: !!js process.env.RESUME_SESSION_ID
    persistenceRoot: './.sessions'
    welcome: 'agent REPL ready. Give it a coding task.'
    persona: |
      You are a coding agent powered by the {{model}} model.
      Verify your work by running the code or tests. Keep answers brief and factual.

# Token 计量：统一定义模型能看到的 token 上限
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
  config:
    contextWindow: 128000

# 自动压缩：对话太长时自动总结旧内容，腾出上下文空间
# thresholdRatio 超过这个比例就触发压缩
# compactionRetries 是压缩后仍超标时的额外重试次数
- id: compact-basic
  name: '@deepseek-ai/dsh-compact-basic'
  config:
    thresholdRatio: 0.8
    retainTokens: 20480
    maxTokens: 8192
    compactionRetries: 1

# 子代理：把子任务分配给独立的 Agent 去做
# subagent 是服务注册，spawn/fork 是两种委派方式：
#   spawn — 全新子代理，不知道父级在聊什么
#   fork  — 继承父级对话上下文的子代理
# tool-subagent 把委派能力暴露给模型，toolName 是模型看到的工具名
- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn
  name: '@deepseek-ai/dsh-subagent-spawn'
  config:
    providerName: spawn

- id: subagent-fork
  name: '@deepseek-ai/dsh-subagent-fork'
  config:
    providerName: fork

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent

- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork

# 动态工作流：模型编写一段编排脚本，引擎在独立 worker 线程里运行它，
# 并通过上面的 spawn 后端把 agent() 调用分发为子代理
- id: workflow-workerthread
  name: '@deepseek-ai/dsh-workflow-workerthread'
  config:
    provider: spawn

- id: tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'

# 任务追踪：模型可以用 todo_write 记录和更新任务清单
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'

# 文件系统：让 Agent 能读写编辑文件
# fs-local 提供本地文件操作能力，cwd 是工作目录
# fs-policy 是安全策略——必须先读才能写，防止模型盲写
# tool-fs 把能力暴露给模型（read / write / edit 三个工具）
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.cwd()

- id: fs-policy
  name: '@deepseek-ai/dsh-fs-policy'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
```

和 echo-agent 对比：同一个 `dsh-stdio-demo` 应用主体，只是把 mock 换成了真实 API，加上了更多工具插件。

## 语法详解

### 插件声明字段

每个插件条目支持以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 插件来源（npm 包名或相对路径） |
| `id` | string | 否 | 实例标识符，用于日志和调试。省略时由 loader 生成并写回 |
| `config` | object | 否 | 传递给插件的配置 |
| `disabled` | boolean | 否 | 设为 `true` 临时禁用该插件 |
| `group` | boolean | 否 | 标记该条目为嵌套分组（`config` 为子条目列表） |
| `inject` | array \| object | 否 | 声明该插件依赖的服务 |
| `intercept` | object | 否 | 按服务名拦截并覆盖下游配置 |
| `isolate` | object | 否 | 服务隔离：服务名 → `true` 或隔离标签 |

### 插件来源 (`name`)

**npm 包** — 已安装的 `@deepseek-ai/dsh-*` 包或第三方包：

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
```

**相对路径** — 本地 TypeScript 文件（相对于 `cordis.yml` 所在目录）：

```yaml
- name: './src/my-tool.ts'
```

### 环境变量 (`!!js`)

用 `!!js` 标签在配置中引用运行时表达式：

```yaml
config:
  apiKey: !!js process.env.DEEPSEEK_API_KEY
  cwd: !!js process.cwd()
```

::: warning
是 `!!js`（两个感叹号），不是 `!js`。写错了会静默失败。
:::

环境变量从仓库根目录的 `.env` 文件自动加载（已被 gitignore）。

### 禁用插件

不想删配置但暂时不加载？加一行 `disabled`：

```yaml
- id: compact-basic
  name: '@deepseek-ai/dsh-compact-basic'
  disabled: true
```

## 各插件配置参考

### stdio-agent（标准应用主体）

**包名:** `@deepseek-ai/dsh-stdio-demo`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | string | **必填** | 使用的模型名，需与 LLM 适配器注册的名字一致 |
| `persona` | string | `''` | 系统提示词。支持 `{{model}}` 等模板变量 |
| `toolOrder` | string[] | — | 模型看到的工具顺序。省略则按字母排序 |
| `persistenceRoot` | string | `'./.sessions'` | 会话日志存储目录 |
| `welcome` | string | `'ready.'` | 启动时显示的欢迎信息 |
| `resumeSessionId` | string | — | 恢复指定会话 ID。留空则每次新建 |

### llm-deepseek（DeepSeek 适配器）

**包名:** `@deepseek-ai/dsh-llm-deepseek`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `apiKey` | string | `$DEEPSEEK_API_KEY` | API 密钥。省略则从环境变量读取 |
| `baseURL` | string | `$DEEPSEEK_BASE_URL` 或官方地址 | API 端点 |
| `models` | string[] | `['deepseek-v4-flash', 'deepseek-v4-pro']` | 注册的模型名列表 |
| `thinking` | `'enabled'` \| `'disabled'` | `'enabled'` | 是否开启思维链 |
| `reasoningEffort` | `'high'` \| `'max'` | — | 思维链深度（仅 thinking 开启时有效） |

### bash-local（Bash 执行器）

**包名:** `@deepseek-ai/dsh-bash-local`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cwd` | string | `process.cwd()` | 命令执行的工作目录 |
| `timeoutMs` | number | `120000` | 单条命令的超时时间（毫秒） |
| `maxTimeoutMs` | number | `600000` | 单条命令超时的上限（模型不能请求更久） |
| `maxOutputBytes` | number | `64000` | 单次输出的内存上限（超出后溢出到临时文件） |
| `graceMs` | number | `3000` | kill 时从 SIGTERM 到 SIGKILL 的等待时间 |

### compact-basic（自动压缩）

**包名:** `@deepseek-ai/dsh-compact-basic`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextWindow` | number | **必填** | 模型的上下文窗口大小（token） |
| `thresholdRatio` | number | **必填** | token 占用超过此比例时触发压缩（0-1） |
| `retainTokens` | number | **必填** | 压缩后至少保留多少 token 的近期内容 |
| `maxTokens` | number | **必填** | 总结时的最大输出 token |
| `summarizationModel` | string | `''`（用当前模型） | 专门用于总结的模型名 |
| `compactionRetries` | number | **必填** | 首次压缩后仍超标时的额外重试次数 |
| `auto` | boolean | `true` | 是否自动在每步前检查并触发压缩 |
| `charsPerToken` | number | `4` | 每 token 估算字符数。中文应设 1-2 |

### fs-local（文件系统）

**包名:** `@deepseek-ai/dsh-fs-local`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cwd` | string | `process.cwd()` | 工作目录，相对路径以此为基准 |

### fs-policy（文件系统策略）

**包名:** `@deepseek-ai/dsh-fs-policy`

无配置项。加载即启用"必须先读才能写"的安全策略。

### tool-fs（文件系统工具）

**包名:** `@deepseek-ai/dsh-tool-fs`

无配置项。加载后向模型暴露 `read`、`write`、`edit` 三个工具。

### tool-web（Web 工具）

**包名:** `@deepseek-ai/dsh-tool-web`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `search` | boolean | `true` | 是否注册 `web_search` 工具 |
| `fetch` | boolean | `true` | 是否注册 `web_fetch` 工具 |
| `searchMaxResults` | number | `8` | 单次搜索返回的最大结果数 |

### subagent-spawn / subagent-fork（子代理后端）

**包名:** `@deepseek-ai/dsh-subagent-spawn` / `@deepseek-ai/dsh-subagent-fork`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `providerName` | string | `'spawn'` / `'fork'` | 注册到子代理服务的 provider 名称 |

### tool-subagent（子代理工具）

**包名:** `@deepseek-ai/dsh-tool-subagent`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | **必填** | 使用哪个 provider（如 `spawn`、`fork`） |
| `toolName` | string | `'subagent'` | 暴露给模型的工具名。多次加载时必须不同 |
| `agentOptions.model` | string | — | 子代理使用的模型名（省略则继承父代理） |

### tool-todo（任务清单）

**包名:** `@deepseek-ai/dsh-tool-todo`

无配置项。加载后向模型暴露 `todo_write` 工具。

### hmr（热替换）

**包名:** `@cordisjs/plugin-hmr`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `root` | string[] | `['.']` | 监听文件变更的目录列表 |
| `base` | string | — | 解析 `root` 的基准目录（默认取配置文件所在目录） |
| `ignored` | string[] | `['**/node_modules', '**/.*', 'cache', 'data']` | 忽略的 glob 列表 |
| `debounce` | number | `100` | 变更合并窗口（毫秒） |

其余字段透传给 chokidar（`Config` 继承 `ChokidarOptions`）。

::: tip
hmr 仅用于开发环境。它需要 `node --expose-internals` 启动参数，`demo:*` 脚本已自动添加。
:::

---

## 加载顺序

`cordis.yml` 的条目是**并发启动**的（loader 对全部条目 `Promise.all`），文件顺序不决定加载顺序。真正的先后关系由依赖协调：插件声明的 `inject` 服务就绪之前，插件不会启动；服务出现后自动继续。所以**不要依赖书写顺序传递时序**——需要"先有 A 再有 B"就让 B `inject` A 提供的服务。

文件顺序只是给人读的。推荐按角色分组书写：

1. **hmr** — 热替换（仅开发时需要）
2. **LLM 适配器** — 模型后端
3. **执行器** — bash、fs 等能力提供者
4. **应用主体** — `dsh-stdio-demo` 或 `dsh-acp-demo`
5. **附加插件** — compact、subagent、todo 等

应用主体内部已经捆绑了核心能力（session、tools、agent-loop），不需要手动加载。

## 下一步

- [开发插件](../develop/basic/) — 编写自己的插件
- [API 参考](../api/) — 查看各插件完整接口
