---
id: IMP-current
kind: implementation
title: 当前源码已经做到哪
status: current
summary: RC2 当前代码已有会话运行、两类业务目录、固定引用、主干和原生上下文管理。
progress: implemented
gap: 真实模型长时间交互、大规模旧图迁移与用户手工并发体验仍需按各交付记录补验；本轮未执行这些产品验收。
relations:
- relation: implements
  to:
    record_id: REQ-product
- relation: implements
  to:
    record_id: REQ-context
- relation: implements
  to:
    record_id: REQ-reader
sources:
- file: ../../README.md
- file: ../superpowers/specs/2026-09-15-native-agent-context-management.md
---

# 当前源码已经做到哪

## 已有

- 会话导入、不可变版本、检查点、持久原生空间与 prepare/attach/drain/close/recover 生命周期。
- 接收会话唯一主干，固定版本和完成截止、按需读取与位置日志、统一撤销。
- Obsidian 系列 / ThoughtDAG 两类业务面板；按工作区和所属会话分页加载；轻量引用镜像。
- 会话正文与“本轮过程”分开；用户请求索引按需读取。
- 原生 Agent 的九个上下文/图工具以及窗口、释放、暂停、固定保留和持久回执。

操作从 README 的使用流程开始。地图整理于 2026-09-16；这是当前工作区源码认识，不是本轮重新安装或启动插件的声明。
