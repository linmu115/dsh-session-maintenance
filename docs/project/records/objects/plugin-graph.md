---
id: OBJ-plugin-graph
kind: object
title: Lynn 插件图与引用原值
status: current
summary: 图、固定引用和贴纸为插件专属数据，维护侧只保留类型与原值并交给 Lynn adapter 映射。
---
旧地图的通用图对象概念已按用户修正收缩：主干图、固定来源、贴纸以及关联关系可由 Lynn 组合插件使用，但不是 Maintenance 核心的数据模型。跨实例恢复时 Lynn 适配器负责将这些原值投放到该插件正常读取的位置，引用身份重映射不能破坏来源边界；无对应插件时保持真源并折叠展示。实现 [[MOD-plugin-adapters]]、接口 [[IF-plugin-data]]。
