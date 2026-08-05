# schedule/ — durable Session-local reminders

English | [中文](README.zh.md)

The Schedule family owns reminders whose durable state and delivery receipt live in the original Session log. A process-local owner waits only while that Session has a live root Agent; cold Sessions resume overdue work when they become live again and never imply an external notification channel.

| Package | Role | ctx key |
|---|---|---|
| `tool-schedule/` | Versioned Schedule events and fold, model-facing create/list/delete tools, live root-Agent timer owner, and pure reminder presentation | — |

The package deliberately exposes no public Schedule service or mutable database. Tools and runtime append to the Session stream, while Web presentation and the browser renderer consume derived, durability-proven views.
