# @deepseek-ai/dsh-tool-cordis

[English](README.md) | 中文

自引用 cordis 工具集：三个面向模型的工具，操作 agent 所处的存活运行时。设计归属（沙箱语义、挂载生命周期、跨挂载组合、生成的 API 目录、既定决策）见[工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

## 功能

- `cordis_inspect`：运行时的只读报告，包括服务、已加载插件列表、已注册工具、动态挂载表，以及目录支持的 `api`／`events` 参考。精确的 `name` 配合 `what: "api"` 或 `what: "events"` 可缩窄报告，并附上原始源代码 JSDoc。
- `cordis_mount`：在 `node:vm` 沙箱中求值模型编写的 JavaScript（一个 async 函数的主体）；代码必须 `return` 一个 cordis 插件，系统将其挂载在 `cordis-dynamic` 分组 fiber 下，并以 `dyn-<n>` 跟踪。
- `cordis_unmount`：按 id 释放一项挂载，只在完全停稳后返回。

精确的面向模型 schema 见[生成的工具目录](../../../docs/tool-catalog.md)。

规范成功值分别为检查字符串、挂载 `{ id, pluginName, state, provides, waitingFor }`，以及卸载 `{ id, pluginName }`。原生 renderer 保留现有文本，因此程序可以使用 `mounted.id`，普通 Function Calling 仍会看到 `mounted dyn-1 (...)`。

## 信任立场

该沙箱隔离全局变量，但不是安全边界。Node 全局变量不存在，或会重定向到 `ctx.fs`、`ctx.web`、`ctx.bash` 等 Cordis 服务；写入 `globalThis` 的内容保持局部，但 host realm helper 使逃逸成为可能。已挂载插件收到不含框架内部机制的 façade，但获准服务仍会影响存活运行时。动态工具 schema 与 annotation 通过迭代式 JSON 克隆和 schema 规范化跨越 realm，因此有效的深层声明受内存而非调用栈限制；含 JSON 不可见 key 的 record，以及子类化或装饰过的 schema array，会在规范化前被拒绝。应当像对待 bash 访问一样对待该工具集；参见[设计与信任立场](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `vmTimeoutMs` | `5000` | 挂载代码求值中同步部分的边界；async 主体可逃出该边界 |

## 生成的 API 目录

`src/api-catalog.ts` 由 `scripts/gen-cordis-api.ts` 生成，使用与 [docs/cordis-catalog](../../../docs/cordis-catalog/services.md) 相同的 AST 遍历，并由 `pnpm run verify-cordis-api`（位于 `doc-sync` 中）实施新鲜度门禁，绝不可手工编辑。`cordis_inspect` 在调用时把该目录与存活服务 store 取交集。宽泛的 `api`／`events` 报告只渲染摘要与签名；精确 `name` 会选择保留的方法／事件 JSDoc，未知或未运行的服务目标会高声失败。

## 渲染

三个工具都渲染 `generic` 卡片（`read`／`execute`／`delete`）；`cordis_mount` 以 `rawInput` 携带挂载代码。presenter 是 args 的纯函数；结果保留默认文本渲染。

## 导出形状

Namespace 插件：命名导出 `name`／`inject`／`Config`／`apply`，无默认导出（[docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

该插件可见时，会话模型会看到生成的 [`cordis_inspect`、`cordis_mount` 和 `cordis_unmount` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis)。

#### Token 影响

该工具视图中的每次请求承担固定 schema 成本。

#### KV Cache 影响

只要该工具视图不变，前缀就保持稳定。隐藏这些定义的 scope 或插件生命周期变更，可能使从第一个变化的 schema token 起的复用失效。

### 工具调用历史与结果

#### 模型看到的内容

检查会精确地用 `## <section>` 加换行及数据相关主体来拼接选中区段，各区段之间留一个空行。宽泛的 API／事件报告省略 JSDoc；`name` 配合 `what: "api"` 或 `what: "events"` 返回一个精确目标及其原始 JSDoc。挂载返回 `mounted <id> (plugin "<name>", state: <state>)`，并可在右括号前插入 ` — waiting for service(s): <names> (activates when provided)`。卸载返回 `unmounted <id> (plugin "<name>")`；未知 id 会变成 `Error: no dynamic plugin with id "<id>" (list mounts with cordis_inspect what:"dynamic")`。提交的挂载程序保留在 assistant 工具调用历史中。

#### Token 影响

检查输出与挂载代码取决于数据，并在压缩前重复发送；生命周期确认文本很短。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 配置项失效。

### 挂载后的后续请求

#### 模型看到的内容

已挂载插件可以注册工具、提示词贡献或监听器，改变其目标 scope 的后续请求；卸载会在完全停稳后移除这些贡献。

#### Token 影响

间接 token 影响等于已挂载插件的贡献，且只在挂载生命周期内持续。

#### KV Cache 影响

挂载或卸载提示词／工具贡献会改变后续请求前缀，并可能使从第一个变化的贡献起的复用失效；挂载集合不变时，前缀保持稳定。

## 已知限制与暂缓事项

- **沙箱只用于约束诚实代码，并非安全边界**：可以访问沙箱全局变量上的 host realm helper，因此挂载代码可以触达 Node；加载该插件时，应当像授予 bash 工具一样慎重（见 § 信任立场）。
- **`ctx` façade 不公开 `effect()`**：挂载代码无法注册定制 disposer；`on`／`provide`／`tools.register` 已覆盖目前出现的每项挂载，受保护的 `effect` 会等待真实需求（`FIXME(sandbox-effect)`）。
- **`vmTimeoutMs` 只限制同步求值**：async 挂载主体可逃出该边界；挂载代码没有 async 预算。
