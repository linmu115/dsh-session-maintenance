---
id: MOD-endpoint
kind: module
title: 端点同步协调
status: current
summary: 维护对齐阶段、世代、策略版本与规范提交，物理读写由端点适配器提供。
relations:
  - relation: implements
    to:
      record_id: REQ-sync-coverage
    reason: 运行期双向变化的逻辑协调
  - relation: provides
    to:
      record_id: IF-endpoint-sync
    reason: 对宿主上报提供统一端点协议
  - relation: consumes
    to:
      record_id: IF-host-writeback
    reason: 对齐时调用宿主提供者执行物理写回
sources:
  - role: implementation
    workspace_id: source
    path: apps/engine/src/endpoint-sync.ts
  - role: implementation
    workspace_id: source
    path: apps/engine/src/endpoint-session-commands.ts
  - role: implementation
    workspace_id: source
    path: packages/canonical-session-engine/src/endpoint-reconcile.ts
---
`EndpointSyncCoordinator` 为每个端点管理 aligning / active / blocked、epoch 和策略修订；同端点对齐去重，写入协调范围内串行提交。旧 epoch 和范围变更拒绝重放。一般已有会话变更等待 active；discover 可在对齐阻塞时按插入式规则处理。

`commitEndpointSessionChange` 将 archive、delete、refresh、discover 变成逻辑操作，重新检查映射与选择范围。原生内容、标题及工作区来源由 DSH 适配器读取后交给规范对齐；核心不自行构造宿主路径或检查 DSH 进程。看板保存同步选择后应及时返回，物理对齐作为独立任务报告进度。

同步的完整目标见 [[REQ-sync-coverage]]；协议与异常见 [[IF-endpoint-sync]]。真实实例是否通过新建到删除的全路径验收，需要按运行回执单独确认。
