# schedule/：持久、仅限 Session 内的提醒

[English](README.md) | 中文

Schedule 家族负责把持久状态与交付回执保存在原 Session 日志中的提醒。进程内 owner 只会在该 Session 拥有 live 根 Agent 时等待；cold Session 再次 live 后会恢复逾期工作，但不会表示存在外部通知渠道。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `tool-schedule/` | 版本化 Schedule 事件与 fold、面向模型的创建／列出／删除工具、live 根 Agent timer owner，以及纯提醒 presentation | 无 |

本包有意不公开 Schedule service 或可变数据库。工具与 runtime 向 Session stream 追加事件；Web presentation 与浏览器 renderer 则消费由已证明持久的前缀派生出的 view。
