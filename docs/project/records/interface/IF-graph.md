---
id: IF-graph
kind: interface
title: 主干图与固定来源怎样交接
status: current
summary: ThoughtDAG 交付图操作意图，Maintenance 核对所属会话、源版本和修订后返回结果。
relations:
- relation: consumes
  to:
    record_id: IF-reference
    project_id: dd46311f-d98d-49ff-ae13-fef0a8a6f9c3
sources:
- file: ../../../../../repositories/thoughtdag/dsh/MANAGED.md
- file: ../superpowers/specs/2026-09-10-session-context-graph-requirements.md
---

# 主干图与固定来源怎样交接

X → Y 表示 Y 可以在固定许可范围内使用 X。主干由 ownerSessionId 标明 Y 的逻辑身份，按需唯一；新增空卡片不是新建真实会话。

Maintenance 提供主干创建/读取/保存/绑定、引用关系、披露目录与统一撤销；Annotation 配合创建和准备实际引用。返回结果包含当前修订及必要的来源状态。来源版本丢失要明确失败，不能偷偷改读最新版本。

删除卡片或连接撤销相应引用，保留真实会话与已有回答。冲突保留编辑并允许恢复；读取位置日志不抢布局修订。消费者必须匹配图协议 2、扩展 schema 2 与当前兼容清单。
