# @deepseek-ai/dsh-tool-fs-search

[English](README.md) | 中文

**面向模型的文件系统发现工具**（`glob`、`grep`）由 **bash 执行器 seam** 支持，而不是由 `ctx.fs` 提供方方法支持。加载时，本包（package）探测 `command -v rg`，探测通过 `ctx.bash` 进行；如果执行器无法在其 `PATH` 上找到 ripgrep，就记录警告，并且不注册工具或提示词段。每次调用都会组装固定的 ripgrep 命令（所有模型控制的值都经过同一个包私有 shell 引用辅助函数），通过 `ctx.bash.resolve(request)` → `ctx.bash.run(spec)` 作为普通前台工具调用运行，解析原始 `rg` 输出，并返回相对于工作目录的规范值。本包注入 `tools`、`systemPrompt` 和 `bash`，有意**不**注入 `fs`；格式化结果 spill 为可选功能，因此机会性读取 `ctx.spillStore`，调用方式为 `ctx.get()`。

```ts ignore-check
// Default deployment: a bash executor whose PATH includes rg, then the discovery tools.
await ctx.plugin(LocalBashExecutor, { cwd: process.cwd() }) // @deepseek-ai/dsh-bash-local
await ctx.plugin(ToolFsSearch)                              // this package — conditionally registers glob/grep
// Optional: a spill backend makes capped results fully recoverable.
await ctx.plugin(LocalSpillStore)                           // @deepseek-ai/dsh-spill-local
```

采用 bash 支持的原因：本地工作区发现天然是由进程支持的 `rg` 工作流；如果把搜索放到 `ctx.fs` 上，就会迫使每个文件系统后端扩展搜索 API。bash 执行器负责请求默认值/上限、子进程执行、进程组终止、环境清理、原始输出捕获和后端替换（本地、沙箱化、远程）；本包负责 schema、参数校验、shell 引用、解析、保留、格式化结果 spill 和超时声明。工具绝不调用 `ctx.bash.start()`，也不公开 bash task id；只有在 `rg` 退出、超时、中止或失败后，调用才会返回。

## 部署要求：rg 与共置的 bash/文件系统

已挂载的 bash 执行器必须能在插件加载时解析 `rg`，其来源是执行器的 `PATH`；否则面向模型的工具 schema 中不会出现 `glob` 和 `grep`。返回路径会相对于解析后的 bash 工作目录显示（调用方 agent（智能体）有会话 cwd 时使用该 cwd，否则使用执行器配置的默认值）；只有 bash 工作目录与文件系统根目录是同一工作区时，才能用 `read` 继续读取。v1 只记录这项共置要求，不执行运行时跨服务校验；远程或虚拟文件系统搜索需等待共享工作区契约或特定提供方的搜索后端。

## 配置

所有键均为可选；默认值是随产品交付的搜索上限。

| 键 | 默认值 | 含义 |
|---|---|---|
| `globMaxResults` | `100` | 一次 `glob` 调用内联保留的最大路径数（与 Claude Code 的 `GlobTool` 上限相同）；后续路径写入格式化 spill 产物。 |
| `grepMaxMatches` | `250` | 一次 `grep` 调用内联保留的最大平铺匹配数（与 Claude Code 的 `GrepTool` `head_limit` 相同）；后续匹配写入格式化 spill 产物。 |
| `grepMaxLineBytes` | `2000` | 每条匹配行预览的字节上限；截断会保留 UTF-8 边界，并标记为 `(line truncated)`。 |
| `rawOutputMaxBytes` | `20000000` | 搜索将解析的完整原始 `rg` stdout 上限（与 Claude Code 的 ripgrep 原始 buffer 相同）；更大的原始输出以 `SEARCH_RAW_OUTPUT_OVERFLOW` 失败。 |
| `timeoutMs` | `30000` | 附加到两个工具定义上的协作式工具调用预算，由 `@deepseek-ai/dsh-timeout-policy` 通过 `exec.signal` 强制执行；bash 后端自身的超时仍作为第二道安全上限。 |

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `glob` | `pattern`、`path?` | 运行 `rg --files --glob <pattern> --sort=modified --no-ignore --hidden`，并排除 VCS 元数据（`.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`）。`path` 是可选的**目录**搜索根；省略时使用解析后的 bash 工作目录。每行返回一个路径，按修改时间排序。 |
| `grep` | `pattern`、`path?`、`include?` | 按行解析 `rg --json`，避免按冒号拆分的歧义。`pattern` 是 ripgrep 正则表达式；`path` 是可选的**文件或目录**目标；`include` 是一个正向 glob 过滤器，前置拒绝逗号分隔列表或否定值（`!…`），但允许 `*.{ts,tsx}` 等花括号交替。返回按文件分组、形如 `Line N: <preview>` 的匹配。 |

常规预算不进入面向模型的 schema（没有 `head_limit`/`offset`/`case_insensitive`/输出模式）：模型需要周边上下文时，用 `read` 读取匹配文件；需要后续结果时，遵循返回的 spill locator 检索提示。

## 两类预算、两类产物

原始 `rg` stdout 是内部传输细节。每次搜索从 bash seam 请求 `stdoutMaxBytes: rawOutputMaxBytes`，且只解析完整保留的 stdout；如果执行器仍返回 `stdout.truncated`，搜索会以 `SEARCH_RAW_OUTPUT_OVERFLOW` 失败，并要求模型缩小查询。成功的 `glob` 在 `{ paths }` 中保留所有已取得路径；`grep` 保留所有已取得的 `{ path, lineNumber, line }`，并将其存入 `{ matches }`。内联条目和每行预览上限只应用于原生渲染器。直接接口调用的逻辑结果超过内联上限时，后置策略会尽力通过 `ctx.spillStore.saveText()` 保存完整格式化预览，并只把呈现替换为头部页面加 locator。嵌套 Code 分派会跳过 spill，因为其完整规范值不会进入模型上下文。spill 缺失/失败时保留内联页面，并报告完整结果无法保存，绝不会成为 `isError`。

## 错误

搜索失败携带本包拥有的 `SearchError`（`HarnessError` 子类），以 `{ name, code }` 公开在 `isError` 结果上：`SEARCH_INVALID_PATTERN`（ripgrep 拒绝正则/glob）、`SEARCH_FAILED`（注册后 `rg` 在运行时消失、目标不可访问、信号终止、`--json` 输出格式错误）、`SEARCH_RAW_OUTPUT_OVERFLOW`（原始输出超过 `rawOutputMaxBytes`，或在请求 stdout 捕获预算后仍被截断）和 `SEARCH_ABORTED`（工具超时、调用方取消或 bash 执行器自身超时）。ripgrep 退出语义由工具拥有：退出 0 表示成功且有结果，退出 1 表示成功的空搜索（`No files found` / `No matches found`），只有其他退出值表示失败。模型参数错误（空白 pattern、列表值 `include`）仍是普通工具参数错误。

## 模型体验

### 系统提示词

#### 模型看到的内容

加载时 `rg` 探测成功后，该插件注册作用域内的每个请求都包含下方独立注册的 glob 与 grep 指导。agent 作用域的工具限制可以隐藏任一 schema，而不移除其提示词段。

##### Glob 指导

```markdown
Use the glob tool — not shell find or ls — to discover files by path pattern. Results are sorted by modification time and include hidden and ignored files.
```

##### Grep 指导

```markdown
Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
```

#### Token 影响

工具注册期间，每个请求支付固定指导成本。

#### KV Cache 影响

只要插件作用域和指导文本不变，前缀就保持稳定。启用或 dispose（资源释放）可能从该提示词段开始使复用失效。

### 工具 schema

#### 模型看到的内容

当前接口可见时，公开已生成的 [`glob` 和 `grep` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs-search)；前提是加载时 `rg` 探测成功。

#### Token 影响

工具可见的每个请求都支付固定 schema 成本。

#### KV Cache 影响

只要工具可见性和定义不变，前缀就保持稳定。注册生命周期或作用域限制可能从首个变化的 schema token 开始使复用失效。

### 结果与 spill 通知

#### 模型看到的内容

`glob` 每行返回一个路径；`grep` 在每个路径下对 `Line <line>: <preview>` 匹配分组。空搜索返回 `No files found` 或 `No matches found`。达到上限的结果末尾会附加省略数量、spill locator 和后端检索提示，或说明完整结果无法保存。

#### Token 影响

内联路径和匹配受 `globMaxResults`、`grepMaxMatches` 与 `grepMaxLineBytes` 限制；调用和保留结果会留在历史中，直到上下文压缩（compaction）。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 工具错误

#### 模型看到的内容

失败会规范化为 `Error: <message>`，并向调用方提供结构化的 `SEARCH_INVALID_PATTERN`、`SEARCH_FAILED`、`SEARCH_RAW_OUTPUT_OVERFLOW` 或 `SEARCH_ABORTED` 元数据。

#### Token 影响

只有失败调用会添加这些保留 token。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **搜索和文件访问没有共享工作区证明**：只有 bash 工作目录和文件系统根目录表示同一工作区时，返回路径才能继续读取；本包不执行运行时跨服务校验。
- **Ripgrep 是部署依赖**：缺失 `rg` 可执行文件时，本包不注册工具或指导；可执行文件不兼容或注册后消失时，调用以 `SEARCH_FAILED` 失败。远程或虚拟文件系统需要共置执行器或其他搜索消费方。
- **schema 只公开一个有界页面**：offset 分页、大小写模式开关、其他输出模式和提供方支持的发现均不在本包内；达到上限的完整输出需要 spill 后端。
