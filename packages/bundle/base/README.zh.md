# `@deepseek-ai/dsh-base`

[English](README.md) | 中文

以 profile 组合包形式交付的共享 dsh 核心：[`cordis.patch.yml`](cordis.patch.yml) 在空的 profile 根之上插入全部基础插件行——模型适配器、工具、持久化、策略、settings／credentials、repository 插件、遥测——作为每个 profile 的 `dsh.profile.bundles` 列表中的第一层。后续的组合包层（例如 [`dsh-web-app`](../web-app/README.md)）和用户 profile 的 `cordis.patch.yml` 按 id 覆盖这些行；patch 会替换目标行的整个 `config`，因此模式专属的值放在各模式组合包中，而不是这里。该包没有运行时 API；profile 组合器通过 manifest（元数据清单）的 `dsh.bundle.patch` 字段解析通用 patch，启动器在 win32 主机上通过代码读取下面的 Windows 平台层。

启动交付 profile 的 Windows 主机还会额外收到 [`windows.cordis.patch.yml`](windows.cordis.patch.yml)：它禁用仅 POSIX 的 bash 执行器/工具与权限栈（dsh-permission 要求有限权能力的执行器），并插入 PowerShell 执行器与工具（`@deepseek-ai/dsh-pwsh-local`、`@deepseek-ai/dsh-tool-pwsh`）。启动器在 win32 主机上把它应用于 bundle 层与用户层之间；偏好 bash 栈的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 覆盖这些行。POSIX 主机永远不会收到它。

行集合及其设计依据以行内注释写在 patch 文件里；[生成的组合图](../../../apps/cli/composition.md)负责渲染它。

## 模型体验

通过插入的行间接产生影响：该组合包选定了随发行版交付的无 persona 提示词基座、工具集合与 DeepSeek 适配器，供各模式组合包进一步特化；它自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响归其所属的包负责。

## 已知限制与延期工作

- **patch 会替换整行 `config`**：profile 覆盖必须重述该行需要保留的每个字段；不存在深度合并层。
- **Windows 上失去权限切换器**：`dsh-permission` 硬性要求有限权能力的 `ctx.bash` 执行器，因此 Windows 平台层随 bash 栈一起禁用 `permission`/`ui-permission`。fs 工具保留 sandbox 策略与批准服务，Windows 上的文件限制与升级仍然生效。
