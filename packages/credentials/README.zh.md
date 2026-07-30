# credentials/

[English](README.md) | 中文

凭据能力把机密值留在提供方拥有的引用背后：

| 包（package） | 角色 |
|---|---|
| [`credentials/`](credentials/README.md) | 抽象 `ctx.credentials`：品牌化 `CredentialRef` 引用与按操作 `resolve` |
| [`credentials-local/`](credentials-local/README.md) | 只读提供方：活跃进程环境叠加按需读取的 `$DSH_HOME/.env` |

配置可以携带 `apiKeyEnv: DEEPSEEK_API_KEY` 这样的引用，而非机密本身。LLM（大语言模型）适配器每次模型请求都会解析该引用，因此从外部轮换的环境变量或 dotenv 值无需重启 harness 即可作用于下一次请求。

已交付的消费方需要时，该 seam 也可以支持由 keyring、辅助命令或 KMS 支撑的提供方。
