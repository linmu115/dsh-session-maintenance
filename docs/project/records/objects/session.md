---
id: OBJ-session
kind: object
title: 逻辑会话、端点身份与工作区归属
status: current
summary: 一个逻辑会话有稳定身份和工作区归属，可关联多个受平台作用域限定的原生端点。
---
逻辑会话 ID 与 DSH/Codex 的原生会话 ID 不互换；工作区“加入维护”、同步范围选择和一个版本在端点上的物理存在也不是同一事实。来源端点、Home/Profile 和当前运行身份经适配器核验。移动工作区、归档、取消归档和删除改变规范事实后，还需要对应端点的成功回执才表示已同步。相关实现 [[MOD-core]]、[[MOD-endpoint]]。
