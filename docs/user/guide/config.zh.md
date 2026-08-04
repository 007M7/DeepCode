# 配置文件

[English](config.md) | 中文

Harness 使用 `cordis.yml` 描述 Agent 加载哪些插件以及每个插件的参数。配置文件负责组合能力；每个包真正支持的字段和默认值由源码生成的配置目录负责记录，避免两份手写表格逐渐不一致。

## 从真实配置开始

仓库中的示例就是可以运行的配置，也是新项目最可靠的起点：

- [共享的 `dsh` base](../../../apps/cli/config/base.cordis.yml) 提供通用的模型、工具、持久化、策略与遥测配置项；原始 `dsh --config <path>` 要求传入一份 patch 列表，用于选择部署特定的 agent 和前端入口。
- [Web overlay](../../../apps/cli/config/web.cordis.yml) 添加浏览器宿主、Workspace 管理、浏览器交互与客户端插件。
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
        provider: deepseek-official
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

原始 `dsh --config <path>` 要求传入一份 patch 列表，并将其直接应用在 `base.cordis.yml` 之上。它不会添加 surface overlay 或 `~/.dsh/config.yaml`，指定文件也不是完整替换树。`dsh web` 先组合 `base.cordis.yml` 与 `web.cordis.yml`，再应用 `~/.dsh/config.yaml`；`dsh web --config <path>` 会以指定 overlay 替代该个人层。Web profile 与 CLI（命令行界面）标志 patch 位于用户层之后。

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
