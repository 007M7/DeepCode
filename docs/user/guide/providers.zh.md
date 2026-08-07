# 配置模型

[English](providers.md) | 中文

Harness 出厂就带 DeepSeek，同时挂着一个通用的多提供方适配器，用来接入 Anthropic、OpenAI 这类内置目录里的提供方，或任何 OpenAI 兼容的网关与自建服务。你有两个入口：Web 界面的**模型**页，以及 `$DSH_HOME/settings.yaml`。两者写的是同一份文档，改完下一次请求即生效，不用重启。

## 提供方从哪里来

`cordis.yml` 决定装了哪些**适配器**，settings 文档决定跑哪些**提供方**。出厂组合里有两个 LLM 适配器：

- `llm-deepseek` 提供 `deepseek-official` 路由，是默认可用的那个。
- `llm-pi-ai` 以**休眠**状态挂载：零路由，模型选择器里也不会多出条目，直到 settings 里的 `llm-pi-ai:` 段落给出 provider profile，路由才注册上来；段落清空则一并撤下。

因此新增一个提供方通常不需要改 `cordis.yml`，写 settings 就够了——而模型页做的正是这件事。

## 在 Web 界面里配置

启动 `pnpm run dsh web`，打开**设置 → 模型**。

![模型页：DeepSeek 卡片，以及添加提供方与添加自定义提供方两个入口](providers-models-page.zh.png)

**填 DeepSeek 的密钥。** DeepSeek 卡片上只有一个 API 密钥输入框，填好保存即可开始用。

**添加内置目录里的提供方。** 点**添加提供方**，从 pi-ai 内置目录中选一个（anthropic、openai 等），填入该提供方的 API 密钥。端点、协议和模型目录都由内置目录提供，你只需要给密钥。

只对以 API 密钥认证的提供方成立。目录里也有 Bedrock、Vertex、Azure、Codex：它们分别需要 AWS 凭据与区域、ADC 项目配置、`api-version`、OAuth，只填密钥框不会让它们工作——这类提供方靠 pi-ai 自己的环境发现认证，凭据按各自的原生方式准备。

**添加自定义提供方。** 点**添加自定义提供方**，用于内置目录没有的路由——公司网关、自建服务，或比内置目录更新的提供方。需要填 Provider ID（请求里点名它、也作为凭据名的小写标识）、API 地址、协议，以及至少一个模型。

![自定义提供方表单：Provider ID、显示名称、API 地址、API 协议、API 密钥](providers-custom-form.zh.png)

**让端点自己报模型。** 展开**模型目录**后点**获取可用模型**，会按你**当前表单里**的地址与密钥去问端点（地址改了但没保存、密钥刚输入还没存下，都算数），把它报告的模型列成候选让你勾选。内置目录里的路由直接由目录作答，不联网。采纳只是把行写进草稿，最终还是你点保存才落盘。

密钥是只写的：页面拿到的永远是脱敏描述符，不是明文。写入的密钥存进 `$DSH_HOME/.credentials.yaml`，profile 里只记录引用它的变量名。

## settings.yaml：进阶配置

文档位于 `$DSH_HOME/settings.yaml`（`$DSH_HOME` 默认是 `~/.dsh`）。模型页写的就是这个文件，你也可以直接编辑它——两个来源没有主次之分。

```yaml
llm-deepseek:
  reasoningEffort: high

llm-pi-ai:
  providers:
    # Catalog route: endpoint, protocol, and models come from pi-ai; you supply
    # the credential.
    openai:
      apiKeyEnv: OPENAI_API_KEY

    # Also a catalog route, moved to a private proxy, with its catalog narrowed
    # to one model and that model's capacity corrected. Every unset field still
    # comes from the catalog.
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      baseURL: https://proxy.example.com:8443
      reasoning: high
      models:
        - id: claude-sonnet-4-5
          contextWindow: 200000

    # Hand-declared route: pi-ai ships nothing under this key, so the profile
    # supplies the whole provider.
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      models:
        - id: acme-large
          name: Acme Large
          contextWindow: 65536
          maxTokens: 4096
```

settings 段落**逐个提供方**地盖在 `cordis.yml` 的同名配置之上，所以你可以只覆盖某个路由的一个字段，其余保持组合里的样子。

一份服务不了的 profile 会在**写入处**被拒绝：手工声明的路由必须给出 `api`、`baseURL` 和至少一个模型，缺了会带着路由名和模型名报错，而不是存下来再让整个命名空间静默失效。已经存好的文档被外部改坏时，settings 会保留上一次的好值并告警。

## 模型目录

`models` 是**替换**该路由的内置目录，不是往里追加；省略或留空则原样使用内置目录。每个条目会从同 `id` 的内置模型继承自己没写的字段，所以「收窄到两个模型」「更正一个容量」「加一个比内置目录更新的模型」都是一行编辑。

可配置的只有 harness 会消费的四个字段：`id`、`name`、`contextWindow`、`maxTokens`。定价与输入模态没有消费方，推理能力也不按模型配置——它随内置目录条目走。

两处容量都没给出的模型，取路由级兜底 `defaultContextWindow`（262144）与 `defaultMaxTokens`（32768）。这两个数按定义就是猜测，所以它们是路由字段：网关服务的模型更小时改一次即可。

模型 id 不是生命周期配置：请求一个该路由没有配置的模型，会在任何网络请求之前以 `UNKNOWN_MODEL` 失败。

## 凭据

使用 `apiKeyEnv`——它是一个**引用**，每次请求时解析，密钥本身不进配置文件。省略它会让路由不带认证，对内置目录路由意味着交给 pi-ai 自己的环境发现。给了引用却解析不到，请求会以 `MISSING_CREDENTIAL` 失败，而不是退回去用环境里碰巧存在的某个不相干的 key 计费。

在 `dsh` 下，引用依次从继承环境、模型页的 `$DSH_HOME/.credentials.yaml` 存储、调用目录的 `.env` 和 `$DSH_HOME/.env` 解析。未挂载凭据服务时，引用只读取同名环境变量。一份凭据供该路由上的所有模型使用。

## 让 agent 用上新提供方

配好的路由会出现在 Web 的模型选择器里，随时可切，这也是最常用的方式。

新会话的默认模型来自 `api-gateway` 那条（`@deepseek-ai/dsh-host-apiproxy`）的 `provider` 与 `model`，出厂值是 `deepseek-official` 与 `deepseek-v4-flash`。要改默认值，就在 `$DSH_HOME/config.yaml` 里覆盖该条：

```yaml
- id: api-gateway
  config:
    provider: acme-gateway
    model: acme-large
```

补丁会整体替换该条的 `config`，所以要把这条需要保留的键一并写出。自行组装的 `cordis.yml`（例如 headless）改的则是 `agent-loop` 的 `agents`。

## 排错

- **`MISSING_CREDENTIAL`** — profile 里的 `apiKeyEnv` 指向的变量没有值。用模型页存一次密钥，或导出该环境变量。
- **`UNKNOWN_MODEL`** — 请求的模型不在该路由配置的目录里。把它加进 `models`，或改用目录里已有的 id。
- **`settings-rejected`** — 写入的 profile 服务不了，错误信息会点名具体的路由和模型。手工声明的路由检查 `api`、`baseURL`、`models` 是否齐全。
- **获取可用模型返回 401** — 端点拒绝了这次探测。检查密钥；若地址指向的是 Anthropic 风格网关，注意探测只读 OpenAI 兼容的 `GET /models`，此时手工填写模型即可。

## 精确字段参考

每个插件当前支持的完整字段、类型与默认值见自动生成的[插件配置目录](../../config-catalog.md)。两个适配器各自的语义由它们的 README 负责：[`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) 与 [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md)。`cordis.yml` 本身的写法见[配置文件](./config.md)。
