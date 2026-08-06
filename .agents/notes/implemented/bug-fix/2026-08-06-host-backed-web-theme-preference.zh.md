# Agent Note: 通过 Host settings 持久化 Web 主题

Status: implemented

[English](2026-08-06-host-backed-web-theme-preference.md) | 中文

## 问题

Web 主题偏好原本存在浏览器 `localStorage` 中。浏览器存储以 origin 为作用域，因此换一个端口重新打开 `dsh web` 会选中另一个存储分区，并回到默认的系统主题，即使两个进程使用同一个 DSH home。

主题是用户级产品偏好，而非页面局部状态。DSH 已有用户 settings 服务及其基于文件的提供方，也已有仅限回环请求的配置协议，并为外部编辑和其他标签页提供失效帧。

## 决策

`@deepseek-ai/dsh-client-ui-theme` 的 Host half 注册 `ui-theme.preference`，可取内置值 `light`、`dark` 与 `system`，默认值为 `system`。本地 settings 提供方将覆盖值存入 `$DSH_HOME/settings.yaml`，在使用默认 home 时，该路径解析为 `~/.dsh/settings.yaml`。

来自回环地址的客户端会在提供 `ThemeService` 之前加载该 namespace，因此初始呈现器快照会反映持久化偏好，无需依赖按 origin 划分的缓存。`ThemeService.setTheme` 仍会同步更新实时快照；它的持久化回调会发送一项 `settings.mutate` 路径操作。控制器按操作顺序串行处理连续快速选择，忽略陈旧操作的结算结果，在最新写入被拒后重新加载持久化值，并在发生 `settings/changed` 或 `connection/reset` 时重新拉取。

API 代理会显式暴露 `ui-theme`，与 `permission` 和 `ui-onboarding` 并列。仅注册该设置，仍不足以跨越配置边界。远程浏览器无法调用特权 settings API，其主题选择仅保留在进程内。

只有产品内置偏好才会跨越 Host schema。第三方注册的主题 id 仍是进程内扩展，因为 Host 无法在启动期间校验浏览器插件的动态注册表。

## 曾考虑的替代方案

**保留 `localStorage`，并在不同端口间复制值。** 一个 origin 无法枚举另一个 origin 的存储，而 Host 侧中继会围绕浏览器特有格式重新实现一套 settings 服务。

**使用不显式包含端口的 cookie。** Cookie 会将偏好的持久性与提供服务的 hostname 耦合，localhost 的不同 alias 仍会各自分区，还会在用户 settings 的所有权模型之外引入 HTTP 状态。

**将 Host settings 镜像到 `localStorage`。** 第二个权威来源会导致启动与失效时需要另外定义冲突规则，同时依然保留造成该缺陷的 origin 分区。Host 侧 settings 文档是唯一的持久化真源。

**暴露所有已注册的 settings namespace。** 自动暴露会让与本功能无关的插件仅凭向通用 settings seam 注册，就成为可远程配置的插件。API 代理保留一份显式 allowlist。

## 后果

主题选择会跟随 DSH 用户 home，跨越重新加载、端口与回环 origin；直接编辑 `settings.yaml` 所产生的变更也会通过现有失效流收敛。settings 文档包含形如 `ui-theme: { preference: dark }` 的可读分节；不会向 `localStorage` 写入主题值。

启动时会在发布主题服务之前执行一次回环 settings 读取。短暂的读取失败会保留系统默认值或上一个正确的进程内值，并可在重连时重试。写入被拒时，界面可能会在主题立即变化后明显恢复为持久化偏好。

单元测试覆盖 schema 注册、有序写入、陈旧响应隔离、故障恢复、失效刷新与远程端仅内存模式。真实 Web settings 场景通过 UI 写入 dark，校验 YAML 文档，重新加载，再使用同一个 DSH home 在另一个端口上启动第二个 Host，此时主题 `localStorage` 分区为空。
