---
id: IMP-scope-business-pages
kind: implementation
title: 工作区策略、运行快照与公共信息页当前实现
status: current
relations:
- relation: implements
  to:
    record_id: REQ-extension-pages
---

# 工作区策略、运行快照与公共信息页当前实现

策略 foundation eb7e9fa、配置 UI 0c8efca、公共信息页 b32c594、Dashboard/host 验收 7dc2067 与实例运行接线 d3695f6 已分别提交。该阶段候选Engine为0.1.33-rc2.38、维护插件0.2.26-rc2.29，随后完成真实安装。当前Dashboard .1.5静态UI已部署并限定验收，Engine .39独立安装未激活、当前仍运行.38；最新状态见 [[IMP-sync-ui-release]]、[[VER-sync-ui-release]]，不把旧候选状态当成当前未安装。

[[MOD-instance-workspace]] 已提供 Maintenance 分类工作区策略、运行快照、投影过滤/缓存和提交复核，以及 Bridge 可选消费的身份/有效范围/会话 availability。用户已确认保存后下次启动生效，旧 run 按自身快照完成写入。

[[MOD-business-pages]] 已具备共享 DTO、Engine 持久注册与动作回执、受信 host 贡献生命周期和 Dashboard 结构化栏目；Bridge 贡献者通过正式共享 schema 的跨仓测试。旧 [[IF-extension-pages]] 与 [[IF-instance-workspace-scope]] 保留原设计入口及来源，运行参数以提供方源码合同为准。

独立 review 找到的 Dashboard /actions 响应丢失后重试生成新 operationId 问题已修复并加入回归：未得到终态前重试保留原请求身份。没有新增任意笔记/样式操作，也未实现替换现有 Viewer 的未来直连管道。范围和测试见 [[VER-scope-business-pages]]。

运行范围与跨仓接线已由 d3695f6 保存；新候选版本、完整构建、公共页重试修复与最终分组验收见 [[VER-scope-business-pages]]。
