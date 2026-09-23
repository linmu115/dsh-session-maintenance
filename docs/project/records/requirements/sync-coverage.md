---
id: REQ-sync-coverage
kind: requirement
title: 已选择工作区的双向会话维护
status: current
summary: 加入维护并选入同步范围的会话应在启动对齐后持续反映新建、续写、改名、移动、归档、取消归档和删除。
sources:
  - role: user-requirement-summary
    path: ../../../changes/2026-09-22-adapter-owned-workspace-sync.md
relations:
  - relation: derived_from
    to:
      record_id: REQ-boundary
    reason: 同一组用户确认的同步目标
---
工作区“加入维护”与“被勾选同步”是两层不同状态；范围选择应可见、持久，未选择的工作区不被实例同步改写。工作区首次加入时映射已有会话，后续变化增量回传。运行期实例已有会话的变更由端点上报，规范存储创建新版本；启动对齐通过宿主适配器写回，双方都须核对身份、范围、版本和回执。

目标变化包括新建、追加对话、标题、工作区归属、归档和取消归档、删除。未完成的对齐不能将已有会话的回传误记为成功；新会话的插入式发现可以独立于反向写回处理。任何物理写入失败都保留原数据，返回可重试或明确阻塞状态。

这是当前要求，不把合成回归等同于真实实例完成验收。代码入口见 [[MOD-endpoint]]，协议见 [[IF-endpoint-sync]]；真实宿主安全写回见 [[IF-host-writeback]]。
