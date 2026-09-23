---
id: MOD-core
kind: module
title: 规范会话与持久化核心
status: current
summary: 维护逻辑身份、版本、工作区、派生、归档和规范存储；不拥有 DSH 或插件业务模型。
relations:
  - relation: implements
    to:
      record_id: REQ-boundary
    reason: 核心保留与宿主无关的会话事实
sources:
  - role: implementation
    workspace_id: source
    path: packages/canonical-session-engine/src/engine.ts
  - role: implementation
    workspace_id: source
    path: packages/session-store/src/canonical-repository.ts
  - role: implementation
    workspace_id: source
    path: packages/contracts/src/opaque-data.ts
---
`packages/canonical-session-engine` 根据规范事件及元数据处理导入、追加、端点对齐、只读 Codex 观察、派生和墓碑；`packages/session-store` 保存逻辑身份、不可变版本、工作区成员及附属原数据；`packages/projection-lifecycle` 和 `packages/transaction-engine` 管投影与可恢复的提交。核心接收规范事件和端点结果，不推断 DSH 目录、Launcher 进程或插件对象语义。

未知结构化事件以不透明数据包保留。它们不是原生指令，也不作为普通正文展示。插件附属记录保留来源 namespace、dataType、recordId 和原值，恢复给插件的工作归适配器。只读 Codex 来源由 Codex 读取适配器观察；原始日志不由 Maintenance 改写。

规范存储的状态与一次物理投放的成功是不同事实。后者必须通过适配器回执确认；失败时不得声称目标已恢复。当前组成与剩余装配耦合见 [[IMP-current-source]] 和 [[ISS-remaining-coupling]]。
