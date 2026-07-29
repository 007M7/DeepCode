# @deepseek-ai/dsh-client-ui-permission

[English](README.md) | 中文

权限预设选择插件（浏览器半侧）：挂在 host `/permission` 命令上的 popupSelect **装饰**（`ctx.command.decorate`）。装饰不是第二条命令——host 命令保留斜杠菜单行、带参路径（`/permission <preset>` 直接切换）与持久生命周期记账；装饰只把裸调用替换为选择框：一张扁平预设列表，当前值标记为 active，选中即提交 `/permission <preset>` 命令行。选项与 active 标记读取会话的 `permissions` 投影（与 composer chip 渲染的同一份 host 计算 select），因此两个界面共享同一读源与同一写路径，推送的投影帧是两者共同跟随的唯一确认。装饰恰在投影 key 存在时可用；无权限组合不显示选择框（装饰绝不无中生有目录行）。

`/client` 导出面为插件本体（`apply`/`inject`）。

## Model Experience

间接影响，经由选择框提交的 host `/permission` 命令：一次切换追加全量值旋钮事件（`permission/preset`、`sandbox/mode`、`approval/policy`），决定后续工具调用解析到的沙箱模式与审批策略。选择框交互本身不添加任何提示词内容。

#### KV Cache effect

无直接失效；请求前缀的变化由旋钮消费方自行承担。

## Known Limitations and Deferred Work

- **尚无无密钥快照覆盖选择框** —— popup 流程由基于 fake face 的单元 spec 覆盖；组装态转写场景随延后的审批/预设 e2e 工作一并补齐。
