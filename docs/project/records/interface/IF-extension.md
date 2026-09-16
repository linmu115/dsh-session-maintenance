---
id: IF-extension
kind: interface
title: 外部插件怎样交给 Maintenance 管理
status: current
summary: 业务插件交付有身份、归属和版本的对象；Maintenance 提供存储、目录与受限领域操作。
relations:
- relation: derived_from
  to:
    record_id: REQ-ownership
- relation: consumes
  to:
    record_id: IF-reference
    project_id: dd46311f-d98d-49ff-ae13-fef0a8a6f9c3
  reason: Core 是引用事务所有者
sources:
- file: ../superpowers/specs/2026-09-15-extension-ownership-and-session-reader.md
- file: ../../README.md
---

# 外部插件怎样交给 Maintenance 管理

## 协作例子

Obsidian 引用从笔记 X 进入会话 Y。引用目录属于 Y；X 只是来源。ThoughtDAG 的主干也属于 Y，其披露记录放在主干下面。

## 谁负责什么

- 业务 Adapter 解释对象和所属会话，保留 namespace、writerId、schema 与修订条件。
- Engine 存储并按业务面板、工作区和会话提供分页目录；索引可以重建，不改原对象修订。
- Annotation 的实时提交事务仍由 Core 管理；Maintenance 只保存有界摘录镜像，镜像只读，不复制完整笔记、日志或模型上下文。
- 图结构变更走图领域接口；通用对象保存不能绕过引用和权限校验。

未映射对象进入待绑定/待核验区；离线、停用和分页未返回不是删除证据。缺少匹配能力时禁用对应写入，其他可用成员仍可读。改变合同需同步 contracts、提取器、兼容声明与消费方。
