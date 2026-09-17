---
id: MOD-reader
kind: module
title: 会话阅读与用户请求索引
status: current
summary: 派生查询分离问答、过程和稳定请求，不改写会话正文。
relations:
- relation: implements
  to:
    record_id: REQ-reader
- relation: implements
  to:
    record_id: REQ-context
sources:
- path: ../../packages/contracts/src/session-reader.ts
- path: ../../packages/contracts/src/user-request-index.ts
- path: ../../apps/engine/src/session-reader-queries.ts
- path: ../../apps/engine/src/user-request-index-service.ts
---

# 会话阅读与用户请求索引

Reader 首屏返回有界问答与过程计数，展开后才读取目录，再选记录才读正文和证据。分类基于平台可信来源，用户粘贴相同英文或标签仍是用户正文。原 Canonical API 保留兼容。

请求索引用稳定 Canonical 用户事件及有证据的 topology/执行边界；展示分组 turn-startSequence 不是永久身份。一个请求可关联零个或多个执行，失败不代表需求已解决。

上游目录须经 referenceId 的固定版本、截止和权限核验；聚合前过滤，游标绑定快照。读请求索引不等于已读对应回答和工具过程。

唯一合同 [Reader](../../../../../../packages/contracts/src/session-reader.ts)、[请求索引](../../../../../../packages/contracts/src/user-request-index.ts)；实现 [Reader 查询](../../../../../../apps/engine/src/session-reader-queries.ts)、[索引服务](../../../../../../apps/engine/src/user-request-index-service.ts)。消费入口 [[MOD-dashboard]]、[[INT-annotation]]。
