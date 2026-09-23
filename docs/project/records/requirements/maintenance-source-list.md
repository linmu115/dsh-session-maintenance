---
id: REQ-maintenance-source-list
kind: requirement
title: 可编辑且默认折叠的真源与同步范围名单
status: current
summary: 工作区名单默认折叠，进入编辑后搜索、勾选并保存；未显式选择即为空，范围保存和宿主对齐分别反馈。
relations:
  - relation: depends_on
    to: {record_id: REQ-sync-coverage}
    reason: 范围名单决定双向同步的有效对象
---
Maintenance 页面可查看实例与维护工作区，编辑模式中搜索、选择、查看已选计数和详情，再保存或取消。保留用户要求的“编辑”入口；卡顿不能通过取消编辑模式掩盖。保存范围应先返回持久化结果，对齐进度、阻塞和成功另行显示，不让长时间宿主操作卡住保存请求。实例侧显式“加入维护”成功后，Maintenance 范围视图应准确勾选并显示该工作区；未显式选择等于空，不存在隐含的 legacy all。

非维护工作区正常留在 DSH，维护但未同步的范围不能被误覆盖。当前源规则见 [[REQ-detached-instance-attach-sync]]；实现与真实界面验收见 [[MOD-ui]]、[[MOD-endpoint]]。旧详细来源：`d3fdbe3:docs/project/records/requirement/maintenance-source-list.md`。
