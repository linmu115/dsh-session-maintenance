---
id: HIST-learning-roundtrip-implementation
kind: history
title: 学习交接首版实现与隔离闭环验证
date: 2026-09-17
status: current
modules: [运行时投影, 看板, Codex 适配, 版本存储]
outcome: 首版代码与隔离验证完成，真实桌面和目标会话尚未部署验收
summary: 实现显式绑定、增量注入、受控回收和冲突锁；真实 CLI 配合本地模拟模型验证上下文进入下一轮请求。
applicability: DSH RC2、Codex CLI 0.153.4 legacy 学习型问答；停止 DSH 后交接、送达后重启 Codex。
coverage_note: Codex 于 2026-09-17 整理，索引本任务第 1055–1567 行公开消息与工具结果；包含实现、失败修正和验证，不含隐藏推理、之后的文档收尾或真实部署。
history:
  path: history/20260917-learning-roundtrip-implementation-final
  sha256: b17898f7da2dacf216d240b8ecb8f249b31b88ccb802d666dd266a61e00f6a94
  capture_sha256: afd89624b0fc4e2d08eb05262d7e28cc303da4855404135617385a5804081013
related_records: [REQ-learning-roundtrip, IMP-learning-roundtrip, VER-learning-roundtrip, HIST-learning-roundtrip]
---

# 学习交接首版实现与隔离闭环验证

用户在需求确认后要求开始实现。实现沿用原逻辑会话及版本库，新增独立实验栏目、绑定记录和交接回执，由 Engine 独占写队列协调。首次绑定接管原来源主线；普通扫描不再替这条学习绑定推进正文或重新分配项目；正常 DSH 续写不产生派生身份。

[查看依据：用户要求开始实现](history-event:EVT-9dbdcbf9ec2c32d4687a)

接口探测确认 thread/inject_items 可持久化问答，但单独启动 app-server 不能保证刷新已运行桌面的内存。因此首版明确要求同步后重启 Codex，且因 DSH 当前缺少已加载会话安全热替换边界，只在 DSH 正常停止、尾部回收完成后开放交接。这是当前工程限制，不是用户原需求新增了重启操作。

隔离协议验收第一次把运行环境封装误计为用户消息，导致消息数和共同前缀检查失败。对照原 Codex 读适配器后剥离运行时封装，同时保留真实请求和引用内容。重跑以真实 CLI、临时 CODEX_HOME、本地固定 Responses 服务完成：问答注入落盘、进程重启后保留、下一轮实际 input 包含注入问题和回答，并按游标读出后续新问答。未调用真实模型。

[查看依据：真实 CLI 隔离协议验收及专项结果](history-event:EVT-f70afdebe0379c58e4e7)

回归发现新增 schema 25 尚未纳入保留治理白名单，以及旧测试固定了导航和历史迁移夹具；修正后相关 57 文件、215 项通过。新增专项补充普通 DSH 续写不分支、扫描不重新分配、元数据改名不误锁、正文改后撤回仍锁定、并发拒绝、回执失败整体回滚、引用快照与非文本拒绝等，最终 19 项通过。一次命令参数误用触发默认并发全量，出现大量超时和原有版本断言失败；本次不宣称全库全绿。

浏览器使用合成数据检查栏目布局和冲突提示。真实“机试DeepLearning”仅做只读身份核对：原逻辑身份及 Codex 来源存在，DSH 当时正在运行；未创建绑定或改动正文。源码交付、安装包部署、真实学习体验分别记录，后两项仍待验证。

操作和限制见 [[IMP-learning-roundtrip]]，可重复验证入口见 [[VER-learning-roundtrip]]。
