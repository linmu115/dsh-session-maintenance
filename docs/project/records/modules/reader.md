---
id: MOD-reader
kind: module
title: 会话阅读、过程折叠与请求索引
status: current
summary: 从规范版本读取可见问答和按需过程，保留来源角色；未知结构化事件默认折叠。
sources:
  - {role: implementation, workspace_id: source, path: apps/engine/src/session-reader-queries.ts}
  - {role: frontend, workspace_id: source, path: apps/dashboard/src/session-reader.tsx}
---
阅读器按稳定版本与请求索引返回会话正文，长过程分级按需加载，区分用户、助手与工具来源。未知结构化或插件原始数据作为可恢复资料保存，默认折叠而非丢弃或作为普通消息显示。业务插件数据的可用性要通过其适配器读回验证，不能仅凭阅读器能展示字节判断已恢复。旧规格仍绑定为 [[REQ-reader]]。
