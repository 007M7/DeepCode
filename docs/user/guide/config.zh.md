# 配置文件

[English](config.md) | 中文

Harness 使用 `cordis.yml` 描述 Agent 加载哪些插件以及每个插件的参数。配置文件负责组合能力；每个包真正支持的字段和默认值由源码生成的配置目录负责记录，避免两份手写表格逐渐不一致。

## 从真实配置开始

仓库中的示例就是可以运行的配置，也是新项目最可靠的起点：

- [共享的 `dsh` base](../../../apps/cli/config/base.cordis.yml) 叠加 [`tui.cordis.yml`](../../../apps/cli/config/tui.cordis.yml) overlay，组合 DeepSeek 模型、Bash、文件系统、压缩、子代理、工作流和交互式 TUI。
- [headless-agent](../../../examples/headless-agent/cordis.yml) 以单次任务形式暴露 coding 组装。
- [acp-agent](../../../examples/acp-agent/cordis.yml) 向程序化 ACP（Agent Client Protocol）客户端提供全新会话。

最小配置由一组插件条目组成：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    models:
      - deepseek-v4-flash

- id: bash
  name: '@deepseek-ai/dsh-bash-local'

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: deepseek
        model: deepseek-v4-flash
```

## 插件条目

`name` 指定 npm 包或相对于 `cordis.yml` 的本地模块，`id` 为插件实例提供稳定标识，`config` 传入插件自己的配置。需要临时跳过某个条目时可设置 `disabled: true`。

```yaml
- id: local-tool
  name: './src/my-tool.ts'
  disabled: false
  config:
    toolName: my_tool
```

插件按文件中的顺序加载。依赖其他服务的插件应该排在提供这些服务的应用或能力插件之后；引用不存在的模型、工具或插件会尽早报错，而不是被静默忽略。

## CLI 覆盖层

TUI 先组合 `base.cordis.yml` 与 `tui.cordis.yml`，再应用一个可选补丁列表。默认的最后一层是 `~/.dsh/config.yaml`；`dsh --config <path>` 会以指定覆盖替代个人补丁列表。`dsh --config-replace <path>` 则把指定文件作为完整配置树启动，不使用已交付配置或个人层。`dsh web --config <path>` 会在共享基础配置与 Web 界面默认值之后、Web profile 与命令行标志补丁之前添加覆盖。

补丁会替换目标行的整个 `config` 值，而不是深度合并各个键。例如，只用 `config: { thinking: disabled }` 修补 `llm-deepseek`，也会移除该行原有的 `apiKey` 与 `baseURL`；因此必须重新写出该行需要保留的全部键。

## JavaScript 值和环境变量

Cordis loader 使用 `!!js` 标签读取运行时表达式。API key 等凭据应放在仓库根目录、已被 Git 忽略的 `.env` 中，不能提交到配置文件。

```yaml
config:
  apiKey: !!js process.env.DEEPSEEK_API_KEY
  cwd: !!js process.cwd()
```

标签是 `!!js`，不是 `!js`。

## 精确配置参考

每个插件当前支持的字段、类型和默认值见自动生成的[插件配置目录](../../config-catalog.md)。理解插件如何组合可继续阅读[架构说明](../../architecture.md)和[能力接口](../../capability-seams.md)；要创建自己的配置，优先复制并修改[示例目录说明](../../../examples/README.md)中最接近的例子。
