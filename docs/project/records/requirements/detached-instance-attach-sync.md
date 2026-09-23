---
id: REQ-detached-instance-attach-sync
kind: requirement
title: 先启动实例、再连接引擎并按真源对齐
status: current
summary: 实例不因引擎缺席被阻止启动；引擎按用户选择的实例目录接管，经确认后只对已选工作区执行真源对齐。
relations:
  - relation: depends_on
    to: {record_id: REQ-sync-coverage}
    reason: 启动前后同步权威由端点阶段区分
---
实例可先于 Maintenance Engine 启动；Engine 之后通过已登记的实例目录、稳定身份和宿主插件握手发现并连接，不以 Launcher 为接管依赖。连接确认、身份/Profile/Home 核对、范围选择和宿主写入屏障是对齐前提。

已勾选工作区在接管前的实例本地变化以真源为准，包括新建、续写和归档；接管并进入 active 后，实例在同一范围内的变化才持续回传。未绑定实例和未选择工作区既不入真源，也不被覆盖，且 DSH 自身仍可正常对话。实例已有工作区须经显式“加入维护”，默认同步选择为空；加入时历史会话的映射按当前范围处理。真源对齐写向实例实际使用的位置，归档状态对称恢复，并核对刷新后宿主可见性。

这是用户确认的目标边界，不能把旧版“未设置范围即全部同步”“引擎缺席则阻断实例启动”或旧原生导入规则当成当前要求。当前实现入口为 [[MOD-dsh-host]]、[[MOD-endpoint]]；真实接管、覆盖和刷新可见性仍须按目标实例回执验收。旧详细来源：`d3fdbe3:docs/project/records/requirement/detached-instance-attach-sync.md`。
