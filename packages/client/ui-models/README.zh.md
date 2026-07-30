# @deepseek-ai/dsh-client-ui-models

[English](README.md) | 中文

模型设置分区插件：提供方配置页。它把三个协议领域汇聚为一个界面——`llm.providers`（可配置提供方目录，含每条路由的存活／休眠状态）、`settings.describe`（序列化 schema、分层脱敏值、secret 槽位）与 `credentials.describe`（不含值的 configured/source/writable 徽标）——并渲染提供方行，一次只展开一张编辑卡片。

行是*已配置*的提供方（其 profile 在所属 namespace 中解析得出）；新增选择框的词汇是全部休眠目录条目，因此裸挂载的 `llm-pi-ai` 在任何路由存在之前就能提供其完整的已安装 catalog。编辑器经 [`@deepseek-ai/dsh-client-schema-form`](../schema-form) 渲染该提供方的 profile 子树；`credential-ref` 角色会挂载凭据控件，它展示该引用的实时状态，并经 `credentials.set` 以**只写**方式存入密钥值——任何值都绝不回显。只有当某行仅由用户层承载时它才可删除（删除会还原组合 base）。

「应用」语义与 settings seam 呈镜像：不含删除的编辑以最小的 `settings.update` 合并 patch 落地（patch 之外已存储的 secret 得以保留），字段重置或整行删除则经对整个用户分节的 `settings.replace` 落地，使删除真正生效。页面加载完成后会在推送的失效事件（`settings/changed`、`credentials/changed`、`models/changed` 与 `connection/reset`）上重拉，因此外部的 `settings.yaml` 编辑、第二个标签页或 settings 新生的路由都无需轮询即可收敛。

## 模型体验

无。该分区渲染浏览器配置 UI；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **重置可能丢弃同一子树中已存储的字面 secret**：经 replace 承载的删除无法重新提供协议从未返回过的 secret；把密钥放在 `credentials.*` 引用背后（产品默认做法），该情形便不会出现。
- **页面上没有逐提供方的模型列表**：模型由选择器呈现；本页只展示路由状态。逐行的模型预览暂缓，待有消费方需要时再实现。
- **未声明的存活路由无处渲染**：未附带可配置提供方声明即注册的路由没有 settings 地址；它在各选择器中仍然可见，但不会出现在本页的行里。
