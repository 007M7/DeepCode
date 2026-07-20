# DSH GUI功能点

（原文照录，含待定标记；文中一张飞书图片无法获取，标注缺失）

## 左边栏
1. session列表
   1. 每一个session左侧小三角按钮▶️可展开子session，默认不展开
   2. 是否需要分成不同的project？自动按照workspace folder分或者让用户手动分？
   3. （待定）session 行显示 live 状态：进行中的 turn 亮活动指示点
   4. （待定）session 行显示基本信息：标题（自动摘要）、最近活动时间、事件/工具调用计数
   5. （待定）如果子session的父session不在列表，是否需要标记？提升？
   6. （待定）子 session 展开后标注 fork 来源的父session
2. （待定）分组方式除 project 外，可按运行态 band（观察 / 迭代 / 运行时）分组
3. （待定）页面收纳/自定义：非核心页面可隐藏收进"可选页面"，由用户勾选启用
4. （待定）顶部/角落全局入口：quick chat（快捷键唤起的浮层输入可进行临时对话）、新建 session
5. （optional）左侧session 列表里标出状态（running/ wait for input/ ask user question等）

## session/agent视图（需细化）
1. 所有的session/agent/sub-agent的可视化
2. （待定）多session聚合视图
   1. （待定）Tree 子视图：每个session的状态点/标题/最近活动/事件·工具·todo 计数/末事件摘要
   2. （待定）Topology 子视图：session的树状 DAG 图，运行中节点高亮，活动边流动动画，点击节点可展开
   3. （待定）Board 子视图：跨 session 的 todo 看板，适用于长程任务、大任务？点击卡片能打开当时的节点、session并fork

### session界面
1. 发消息
   1. 在idle状态正常发，queue, steering
   2. Fork session
   3. Goal 功能
   4. btw/side 功能
2. 思考
   1. 滚动展示思维链更新、可展开
   2. （待定）用户上滚时不强制跟随
3. Tool call
   1. 可用plugin自定义每个tool call如何展示
   2. 需要注意：code mode, cordis tool 的展示希望做得好一点
      1. Dynamic workflows 也能展示
   3. （待定）diff 卡、terminal 卡（scrollback）、widget 卡（表格/图表/选项/键值等svg动画）
   4. （待定）round / turn / step 层级展示（round 为可折叠分组（仅 goal/loop session 有），turn/step 平铺不缩进，渐进披露）
   5. （待定）step 与工具行是否可以融合？这样折叠态只有一行（token 分值+时长），展开见参数/结果/子事件。还是不融合
   6. （待定）edit & re-run：改工具参数重跑
4. 消息、思考、tool call等都可点击，在右边栏展示
   1. 可看到session log里原始记录
   2. 可看到json格式
   3. 可以标注feedback（optional）
5. 改设置
   1. Thinking level / sandbox / mode。
6. Find in Finder（对应的 jsonl 可以一键打开）
7. （待定）feedback 标注入口，与 RL/rubric 标注链路打通
8. （待定）compact 压缩可视化（折叠横幅 + token delta）
9. （待定）context 注入可见（inject/recall/steer 卡）
10. （待定）md 渲染 / html 预览
11. （待定）消息 edit-rerun、fork from here 悬浮入口

### 甘特图/时序图界面（session界面tab）

### trace界面？（session界面tab）
1. 是否需要做还是和session界面合并？
2. （待定）建议：都做，Tracing 一级页做一个跨 session 索引（成本/错误率/P50/P99/tokens/cost 汇总表等等）；单 session 内也能看tracing，session 界面内的 tab（tri-view：Tree / Timeline / Graph）并且将trace 语义信号（loop / 重复调用 / plan 变更 高亮）作为独立需求点

### 看session log jsonl的界面（session界面tab）
1. 可过滤session log类型
2. 可点击到右边栏展示（同session界面）
3. （待定）
   - 本 session 全量回放（走 session/events）
   - 全局实时事件流（跨 session、ring buffer、开发者调试面）
   - 是否支持过滤？按事件类型 chips + 文本搜索

### 输入框
1. 支持多行输入
2. （optional？）支持图片输入
3. 支持 slash 命令
4. （optional？）支持 bash 模式（直接运行bash命令）
5. 支持修改：
   1. Model & thinking effort
   2. Permission & sandbox

## plugin视图（需细化）
1. 安装新plugin
2. 当前已安装的plugins
   1. 在这里直接改cordis.yml？
3. （待定）Vibe a plugin：让模型自己写插件并挂进自身运行时
4. （待定）Playground：测试plugin

## config视图（需细化）
不一定是视图，作为角落的一个setting 按钮，点开能配置这些也可以。界面的主体可能就是个"打开cordis.yml"按钮？
1. agent 配置
   1. Model & thinking effort
   2. Permission & sandbox
（此处原文有一张飞书图片，无法获取，缺失）

## Onboarding（optional）
首次打开时，支持快捷配置：
- Choose model -> enter api key
- 勾选插件 -> 勾选每个插件具体配置
