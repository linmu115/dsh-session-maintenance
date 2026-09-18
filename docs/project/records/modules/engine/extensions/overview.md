---
id: MOD-extension-store
kind: module
title: 扩展存储、冲突与目录
status: current
summary: 扩展注册独立于平台，业务写入保护先于通用保存。
relations:
- relation: provides
  to:
    record_id: IF-extension
- relation: implements
  to:
    record_id: REQ-ownership
sources:
- path: ../../apps/engine/src/extensions/service.ts
- path: ../../apps/engine/src/extensions/directory.ts
- path: ../../apps/engine/src/extensions/annotation-sync.ts
---

# 扩展存储、冲突与目录

ExtensionDataService 按 namespace 和实例/Profile 接入声明检查兼容。缺能力时保留通用元数据；正文读写须 ready、schema 匹配且具备对应能力。

写入核对 writerId、expectedRevision、schema 与删除/恢复权限，相同内容不增修订，冲突保留候选。annotation-records 拒绝通用写；managedSchema 2 图强制走领域入口；annotation-context 不提供普通写能力。

Adapter ownership 解释所属会话，目录索引可重建而不改对象 revision；工作区沿现有成员关系。一个业务面板可聚合多个 namespace，部分可用不等于全部可写。

[ExtensionDataService](../../../../../../apps/engine/src/extensions/service.ts)、[目录服务](../../../../../../apps/engine/src/extensions/directory.ts)、[镜像同步](../../../../../../apps/engine/src/extensions/annotation-sync.ts)为实现。合同 [[IF-extension]]，接入目录 [[INT-business-directory]]。

GPT 扩展 gpt-compat 由已提交会话版本建立只读索引，按实例/Profile 和所属会话隔离。相同版本不重复生成修订，密文保留在原始会话而不进入索引正文；见 [[INT-gpt-format]]。

## 注册汇总与绑定登记（已接入，最终验证进行中）

新增 [[IF-extension-pages]] 要求每个贡献方只维护自己的登记，由公共注册器汇总完整名单；保留现有 namespace、writer、schema 与领域写限制。Obsidian 绑定信息是 Bridge 确认后的维护登记，不能用实例分区中的两条普通对象代替 Vault 唯一绑定校验。

当前运行范围服务见 [[MOD-instance-workspace]]；公开信息页与贡献者生命周期见 [[MOD-business-pages]]。实现和最终验证边界分别见 [[IMP-scope-business-pages]]、[[VER-scope-business-pages]]。
