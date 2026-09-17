---
id: IMP-current
kind: implementation
title: 当前源码已经做到哪
status: current
summary: 当前 RC2 支持会话、持久运行、续接、扩展目录、主干和原生上下文；部署另查。
progress: implemented
gap: 本轮仅核对地图与关键源码，真实模型、全部旧图迁移、用户并发及当前部署未复验。
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
- path: ../../README.md
---

# 当前源码已经做到哪

- 历史/来源：[[MOD-canonical]] 和 [[MOD-harness-codex]]，不可变版本、检查点、工作区、只读 Codex 镜像。
- 运行/恢复：[[MOD-runtime]] 和 [[MOD-host]]，持久空间、租约、WAL 与回执。
- 新 Codex 续接：[[MOD-continuation]]，固定来源预览、可追踪作业与恢复。
- 业务对象：[[MOD-extension-store]] / [[MOD-business]]，八个 namespace、三类业务面板、归属索引与轻量镜像。
- 主干/上下文：[[MOD-graph]] / [[MOD-native-context]]，固定许可、撤销、日志、窗口和持久释放。
- 阅读：[[MOD-reader]] / [[MOD-dashboard]]，分页问答、过程和请求目录。

日常操作 [[IMP-usage]]，配套版本 [[IMP-versions]]。本次以当前 README、合同和关键实现核对，不代表新安装或运行验收。

真实模型长时交互、全部旧图迁移、真实用户并发和当前部署未重验。历史产品证据 [[VER-context]]、[[VER-reader]]；地图验证 [[VER-adoption]]。

本次纠正 [[INT-gpt-format]]：GPT 属于扩展数据，独立注册解析器和业务面板；宿主保留 dsh-0.1.5 身份。源码版本 Engine 0.1.33-rc2.30 / 插件 0.2.26-rc2.24。过程见 [[HIST-gpt-extension-boundary]]，实际部署证据另见本轮报告。
