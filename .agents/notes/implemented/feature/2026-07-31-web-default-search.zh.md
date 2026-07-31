# Agent Note: Web／无头组合中的默认 Web 搜索与抓取

Status: implemented

[English](2026-07-31-web-default-search.md) | 中文

## 问题

该 harness 已具备完整的 Web 能力体系：提供方注册表、DeepSeek、Exa 和 Perplexity 搜索提供方、本地抓取、稳定的面向模型工具，以及结构化结果呈现，但已交付的 `dsh web` 组合没有挂载其中任何一项。除非部署提供自定义覆盖层，否则模型无法发现最新信息，也无法沿来源 URL 读取内容。仅挂载现有 DeepSeek 提供方仍无法打通 WebUI 链路：Models 页面通过 `ctx.credentials` 存储 `DEEPSEEK_API_KEY`，而搜索提供方只会在插件加载时固定读取进程环境，因此在运行中的 UI 输入或轮换的密钥无法用于搜索。

## 决策

`apps/cli/config/web.cordis.yml` 明确挂载 `dsh-web`，并配置 `searchProvider: deepseek-official` 与 `fetchProvider: local-http`，同时挂载 `dsh-web-search-deepseek`、`dsh-web-fetch-local` 和 `dsh-tool-web`。共享覆盖层使 `web_search` 和 `web_fetch` 成为浏览器与无头会话的默认工具；TUI 组合保持不变。显式提供方 id 使选择不受注册顺序影响，同时个人覆盖层或 `--config` 覆盖层仍可替换或禁用这些配置项。

DeepSeek 搜索使用与官方会话适配器相同的 `DEEPSEEK_API_KEY` 凭据引用。提供方在每次搜索内部通过可选的 `ctx.credentials` 服务解析该引用；只有未挂载该 seam 的组合才会回退到启动进程的环境变量，非空的 `apiKey` 字面值仍作为程序化配置的最后兜底。因此，由 Web 的 Models 页存储或轮换的密钥无需重启即可用于下一次搜索，提供方也无需保留该值。由于 `WebSearchProvider.available()` 是同步方法，它会将已安装解析器视为本地可用；若动态凭据缺失，操作会以提供方专属错误码 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，而稳定的工具 schema 仍保持注册。

搜索端点与 chat completions 保持独立：`DEEPSEEK_SEARCH_BASE_URL` 覆盖 Anthropic 兼容基址，`DEEPSEEK_BASE_URL` 则继续配置会话请求。每次 `web_search` 都会发起一次辅助 DeepSeek Messages 调用，并携带原生搜索服务器工具。`web_fetch` 使用现有的匿名本地 HTTP(S) 提供方，因此无需其他厂商账号即可获取搜索结果。

默认挂载不会创建 Web 专用权限策略。这些工具在 bash／文件系统沙箱及审批预设之外执行，并遵循 `dsh-tool-web` 的现有契约。已交付部署的默认值本就是 `danger-full-access`；未来如果产品采取受限网络策略，必须添加 `tools/pre-execute` 策略或按能力限制网络访问，而不能暗示文件系统访问模式会管辖 Web 调用。

## 考虑过的替代方案

**仅挂载 `dsh-tool-web`。** 不予采纳：稳定的 schema 如果没有已注册提供方，每次默认调用都会失败。启用状态与后端可用性刻意分离，但已交付的默认配置必须提供其预期实现。

**从 `cordis.yml` 读取 `$DSH_HOME/.env`，或将其提升到 `process.env`。** 不予采纳：凭据提供方拥有该文件，环境变量值是只读覆盖；提升后存储的密钥将无法轮换，还会绕过经审计的密钥边界。

**在提供方加载时固定读取 `process.env.DEEPSEEK_API_KEY`。** 不予采纳：Web Models 页面通过 `ctx.credentials` 写入密钥；产品文档规定的首次运行路径必须保证下一次操作无需重启即可生效。

**在 `base.cordis.yml` 中挂载 Web 工具。** 不予采纳：这也会改变 TUI 部署。浏览器与无头入口已经共享 `web.cordis.yml`；两者会一同获得该能力，是否为 TUI 启用则仍留作后续显式决策。

**启用搜索但不启用抓取。** 不予采纳：搜索 snippet 是用于发现内容的上下文，而不是页面正文；稳定的搜索指引会要求模型先抓取相关结果，再依赖其完整内容。

## 后果

Web／无头模型请求在原生模式下会携带 `web_search` 和 `web_fetch` schema 及其固定提示词指引；Code Mode 通过 `run_code` 公开相同能力。搜索会增加一次完整的辅助模型调用，并可能多次使用原生服务器工具；抓取会增加匿名出站 HTTP(S) 访问，并受本地提供方的重定向、大小、超时和内容类型规则约束。Web 快照通道会启动已交付配置树，使用本地 Messages fixture（测试前置数据），经由真实 DeepSeek 提供方驱动一次回放的 `web_search` 调用，断言持久化的结构化结果，并固定最终浏览器呈现。提供方测试固定缺失、已存储及已轮换凭据的行为，以及字面值与环境变量的兼容性。
