# web 侧 Cordis 插件系统设计

- **状态**：v1 全稿完成（2026-07-20），§E 装配与配置含 Q1–Q7 问题清单待用户拍板后定稿；其余章节可 review
- **追加输入（2026-07-20）**：用户升格「双端插件包 + web Loader 可配置化」为核心命题，§E 由此从「build 期静态装配一句话」扩为七问选项分析
- **负责人**：web-cordis-design teammate（常驻）
- **命题**：在浏览器侧建一套与 node harness 对等的 Cordis 插件系统——回答「web root context 上注册哪些 Service」「哪些与 node 对等、哪些各端独有」。本轮只设计服务层地基，不含 UI 插件（tool renderer/面板注入），不写代码。
- **产出**：design.md（§A cordis 浏览器可运行性 → §B 服务清单 → §C 手工模块插件化路径 → §D 跨端通信面 → §E 装配与配置 → §F 分期 → §G 妥协台账）
