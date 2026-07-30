# @deepseek-ai/dsh-storage

[English](README.md) | 中文

非会话数据的存储中心（`ctx.storage`）：命名后端注册表加已挂载的数据形式设施。中心自身不执行 IO：后端拥有介质，数据形式拥有语义。设计与取舍见[领域 KV 存储 Agent Note（agent 决策记录）](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 结构

- `ctx.storage.backend`：名称 → 后端表。多个后端并排保持挂载（`json`、`sqlite`）；为消费方提供服务的后端由该消费方自身的配置决定（领域层的路由表），绝非中心的全局选择。`register()` 返回资源释放函数；注册重复名称或查找未知名称时都会明确报错。
- `ctx.storage.mount(form, facility)`／`ctx.storage.form(form)`：数据形式挂载。`StorageForms` 可通过合并扩展；领域层合并 `domain`，并通过 `ctx.storage.domain` 访问。
- 后端拥有一种介质（文件树根、数据库文件），并公开可选的数据形状**分面**：目前为 `kv`；为未来的会话后端迁移预留追加日志分面。`src/backend.ts` 是规范契约文本；`tests/contract.ts` 导出每个后端都会运行的共享一致性测试套件。

## 该分组中的包

| 包（package） | 职责 |
| --- | --- |
| `dsh-storage` | 中心服务 + 后端词汇 + 共享一致性测试套件 |
| `dsh-storage-json` | JSON 后端：每个单元一个人类可读文件，以原子方式重写整个文件 |
| `dsh-storage-sqlite` | SQLite 后端：一个数据库承载所有已路由单元，每行一个文档 |
| `dsh-storage-domain` | 领域数据形式（`ctx.storage.domain`）：类型化 schema、写入链、变更事件 |

## 模型体验

### 后端与形式注册

#### 模型看到的内容

无。`ctx.storage` 是主机侧注册表；中心不注册工具、不注入提示词，也不写入会话事件。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与实时请求相互独立：中心绝不触碰请求前缀，因此无法使提供方缓存复用失效。

## 已知限制与暂缓事项

- **`kv` 是唯一的数据形状**：设计记录为未来的会话后端迁移预留了 append-log facet，但尚未定义；后端目前恰好只有一个 facet 需要实现。
- **数据形式按需解析**：在领域插件挂载前读取 `ctx.storage.domain` 会抛出 `form-not-mounted`；组装会按相应顺序排列插件（错误配置会明确报错，而不是静默推迟处理）。
