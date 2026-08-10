# `@deepseek-ai/dsh-base`

[English](README.md) | 中文

以 profile 组合包形式交付的共享 dsh 核心：[`cordis.patch.yml`](cordis.patch.yml) 在空的 profile 根之上插入全部基础插件行——模型适配器、共享的 [`agent-default-model`](../../core/agent-default-model/README.md) 选择、工具、持久化、策略、settings／credentials、repository 插件、遥测——作为每个 profile 的 `dsh.profile.bundles` 列表中的第一层。后续的组合包层（例如 [`dsh-web-app`](../web-app/README.md)）和用户 profile 的 `cordis.patch.yml` 按 id 覆盖这些行；patch 会替换目标行的整个 `config`，因此模式专属的值放在各模式组合包中，而不是这里。该包没有运行时 API；profile 组合器通过 manifest（元数据清单）的 `dsh.bundle.patch` 字段解析 patch，绝不通过代码。

启动交付 profile 的 Windows 主机还会额外收到 [`windows.cordis.patch.yml`](windows.cordis.patch.yml)：它禁用仅 POSIX 的 bash 栈（`bash-sandbox`/`tool-bash`），并插入沙盒受限的 PowerShell 栈（`@deepseek-ai/dsh-pwsh-sandbox`、`@deepseek-ai/dsh-tool-pwsh`）。权限面与 POSIX 完全一致：`sandbox`/`sandbox-policy` 通过 Windows ACL 受限令牌 runner（`dsh-sandbox-local` 的 win32 链 → `@deepseek-ai/dsh-sandbox-windows-acl`）执行文件效果策略，权限切换器与 approval 服务原样运行，`fs-sandbox` 继续围栏 `ctx.fs` 写入——在其旁再挂载 `dsh-fs-local` 会重复注册 `ctx.fs` 并在加载时失败。启动器在 win32 主机上把该层应用于 bundle 层与用户层之间；偏好不限权本地 pwsh 执行器或完整访问的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 覆盖这些行（bash 恢复配方必须完整：禁用 `pwsh-sandbox`/`tool-pwsh` 并重新启用 `bash-sandbox`/`tool-bash`——两个执行器家族注册同一个 `bash` 服务，配方不完整会在加载时 fail loud）。POSIX 主机永远不会收到它。

行集合及其设计依据以行内注释写在 patch 文件里；[生成的组合图](../../../apps/cli/composition.md)负责渲染它。

## 模型体验

通过插入的行间接产生影响：该组合包选定了随发行版交付的无 persona 提示词基座、工具集合与 DeepSeek 适配器，供各模式组合包进一步特化；它自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响归其所属的包负责。

## 已知限制与延期工作

- **patch 会替换整行 `config`**：profile 覆盖必须重述该行需要保留的每个字段；不存在深度合并层。
- **Windows 的临时目录授权是按会话的私有子目录**——`workspace-write` 把写入限制在工作区与会话自己的 temp 子目录（`<temp>\dsh-<hash>`，受限子进程的 TMP/TEMP 被改写）；`read-only` 不授予任何写入。见 `@deepseek-ai/dsh-sandbox-windows-acl`。
