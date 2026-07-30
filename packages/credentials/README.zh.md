# credentials/

[English](README.md) | 中文

凭据能力 seam，按三包形态的要求组织（接口／实现／消费方）：

| 包 | 角色 |
|---|---|
| [`credentials/`](credentials/README.md) | 抽象 `ctx.credentials`：品牌化 `CredentialRef` 引用、按操作 `resolve`、对 UI 安全的 `describe`、响亮失败的 `set`/`unset`，以及 `credentials/updated` 提交事件 |
| [`credentials-local/`](credentials-local/README.md) | 文件／环境 provider：活跃进程环境（只读、优先）叠加在 `$DSH_HOME/.env`（可写、保字节行级编辑、热重载）之上 |

配置文件携带的是对机密的*引用*（`apiKeyEnv: DEEPSEEK_API_KEY`），绝不携带机密本身：设置文档可以放心同步与渲染，轮换值不触碰任何配置。LLM 适配器是第一批消费方——它们每次模型请求解析一次引用，正因如此，片刻前存入的密钥无需重启任何组件即可作用于紧随其后的下一次请求。

seam 形状为 keyring、辅助命令与 KMS 后端的 provider 留有余地。
