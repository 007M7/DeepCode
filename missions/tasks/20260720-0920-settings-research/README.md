# Settings 设置页可透出面调研

- **日期**：2026-07-20
- **命题**：将来 web GUI 的 Settings 页，从 harness（node 服务端）能透出什么？系统列一遍，标注每项可行性与形态，供用户圈选。
- **范围**：只调研列清单，不设计不实现。逐项去源码核实，带 file:line。
- **产出**：[settings-inventory.md](settings-inventory.md) —— 配置项大表 + 一期最小集提案。

## 调研面

1. host 侧现状可读面（bootHost/startHost 配置、LlmDeepSeek apiKey/baseURL、host.describe 现返回）
2. 插件/服务可观测面（Cordis registry 枚举能力、已加载插件+状态查询面）
3. 模型/Provider 面（adapter 注册表枚举、运行时切 provider/model 可行性）
4. 纯前端本地项（深色模式/语言/面板偏好，不经 RPC）
5. 每项标注：读/写、生效方式、敏感度、契约增量
6. 参考先例：opencode settings/config 设计
