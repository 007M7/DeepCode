# @deepseek-ai/dsh-client-remotes

[English](README.md) | 中文

为本应用选定的 Host Remote 能力提供平台无关的 Client 外观。其 Client 入口以运行时值形式导入生成的 `/remote` 产物，通过 `ctx.api` 挂载每项贡献，并重新导出对应的声明合并。Client 业务包依赖此外观，而不依赖 Host API Gateway 或单独的 Remote 运行时入口。

当前组合仅挂载 Goal Remote 贡献。该组合卸载时，Cordis effect 的所有权机制会撤回所有贡献；`@deepseek-ai/dsh-host-api-gateway` 的 Client 侧负责描述符校验、具体的根级方法和作用域方法、调用与取消。

本包不包含传输逻辑或 Host 发现逻辑。Web 和未来的 TUI Client 只要提供同一份不依赖 React 的 `ctx.api` 契约，均可复用本包。

## 模型体验

无，因为此 Client 组合只选择应用的 Remote 方法，不注册任何模型接口。

#### KV Cache 影响

无直接影响；其触发的任何模型可见行为均由已挂载的 Host 能力负责。

## 已知限制与暂缓事项

- 能力集合由构建时显式导入的值固定确定；Client 不会在运行时发现 Host 中已启用的服务或 Remote 定义。
- 若要增加能力，必须显式导入相应的 `/remote` 值并在此组合中挂载。
