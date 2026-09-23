---
id: OBJ-extension
kind: object
title: 插件原数据与所属会话
status: current
summary: 插件记录带来源 namespace、类型和 recordId，忠实保存原值；插件业务含义由对应适配器解释。
---
插件对象的所属会话与其引用来源可以不同。Maintenance 只保存身份、原值、版本与投放状态，不把 Lynn 图、GPT 事件或未知结构化数据变成通用图模型。无目标插件时保持可恢复，目标有插件时经握手、映射和正常读取验证后才记为可用。接口 [[IF-plugin-data]]。
