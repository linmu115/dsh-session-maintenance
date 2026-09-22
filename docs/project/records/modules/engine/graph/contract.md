---
id: IF-graph
kind: interface
title: 主干图与固定来源怎样交接
status: current
summary: 当前会话范围内的图/引用意图经 Engine 核验，返回修订及明确状态。
sources:
- path: ../../packages/contracts/src/session-graph.ts
- path: ../../packages/contracts/src/session-context.ts
- path: ../../plugins/dsh-session-maintenance/src/session-graph.ts
- path: ../../plugins/dsh-session-maintenance/src/session-context.ts
- path: ../../apps/engine/src/http/session-graph-routes.ts
---

# 主干图与固定来源怎样交接

2026-09-22 架构归属修正：以下是 Lynn adapter 的兼容业务协议，不是 Maintenance 核心的通用图模型。实现与领域路由已迁到 `apps/engine/src/adapters/lynn`，旧路径仅转发；核心保存原数据和通用会话版本。见 [[IMP-lynn-adapter]]。保留本协议用于已有插件消费者。

用户从 X 的已完成回复向 Y 引用，宿主先 flush 涉及会话，Engine 固定 X 的版本与截止。Y 主干显示该关系；ThoughtDAG 保存布局只能引用此关系，不能改大授权。

唯一技术合同：[图协议及 schema](../../../../../../packages/contracts/src/session-graph.ts)、[固定引用与读取合同](../../../../../../packages/contracts/src/session-context.ts)。

| 能力 | 宿主入口 | 效果 |
| --- | --- | --- |
| 定位与预览 | resolve / preview / directory | 当前运行身份及固定完成位置 |
| 主干与布局 | ensure / load / save / bind | 修订检查与延迟绑定 |
| 移除/归档 | remove / revokeSource / setSessionArchived | 撤销引用和图，保留真实会话 |
| 固定披露 | context.capture / read / settleRead | 版本、截止、预算及交付状态 |
| 目录与日志 | relations / disclosures / sourceMarkers | 有界元数据及读取位置 |

实现入口 [MaintenanceGraph protocol 2](../../../../../../plugins/dsh-session-maintenance/src/session-graph.ts)、[MaintenanceSessionContext protocol 1](../../../../../../plugins/dsh-session-maintenance/src/session-context.ts)、[领域 HTTP 路由](../../../../../../apps/engine/src/http/session-graph-routes.ts)。来源丢失、未完成、错误归属、冲突或循环须明确失败，不改读最新版本。通用 [[IF-extension]] 不能绕过领域检查；已知消费者 [[INT-annotation]]、[[INT-thoughtdag]]、[[INT-stickers]]。
