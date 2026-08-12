# 配置文件

[English](config.md) | 中文

harness 使用 `cordis.yml` 描述 agent（智能体）加载哪些插件以及每个插件的参数。配置文件负责组合能力；每个包真正支持的字段和默认值由源码生成的配置目录负责记录。

## 从真实配置开始

仓库中的示例就是可以运行的配置，也是新项目最可靠的起点：

- [`dsh-base` 组合包补丁](../../../packages/bundle/base/cordis.patch.yml) 提供通用的模型、工具、持久化、策略与遥测配置项，每个 profile 都以此为起点。
- [`dsh-web-app` 组合包补丁](../../../packages/bundle/web-app/cordis.patch.yml) 添加浏览器宿主、Workspace 管理、浏览器交互与客户端插件。
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

Cordis 会并发启动同级配置项。插件通过 `inject` 声明必需服务；Cordis 会等到这些服务就绪后再应用该插件，因此文件顺序不能保证依赖已就绪。引用不存在的模型、工具或插件会尽早报错，而不是被静默忽略。

## CLI 补丁层

`dsh --profile <name>` 按该 profile 的 manifest（元数据清单）中 `dsh.profile.bundles` 列表的顺序，在空根之上组合各组合包补丁层，随后依次应用该 profile 自己的 `~/.dsh/profiles/<name>/cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml` 与每个 `--patch <path>` overlay。同一行以较后的层为准。应用 flag 并不是另一层 patch：组合包中的普通插件注入 `cmdlineArgs`，再把解析值作为自身服务提供；注入该服务并保留其 `!!js` 读取的行会让本次调用的取值优先。

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
