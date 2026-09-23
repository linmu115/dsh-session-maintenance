---
id: HIST-context-progress
kind: history
title: 让长历史压缩等待可见
date: '2026-09-18'
status: current
modules:
- 运行时投影与兼容校验
summary: 先展示待发送输入，再展示真实压缩阶段；保留引用原文并避开并行 Sidechat 迁移。
outcome: 已部署，真实页面组件加载和模拟压缩/失败/成功状态验证通过；未代用户发送真实消息。
applicability: GPT 0.5.0-dev.7；Core 0.3.12-rc2.18-progress.1；Maintenance Engine 0.1.33-rc2.36。
coverage_note: Codex 整理本次公开来源第 3636–3982 行。仅索引，不复制原会话内容。
history:
  path: history/context-progress-20260918
  sha256: 3c3f08ffa7ba9d65d944f7fc34c05622a3f6d0024d6773a11a175cc91e8b25e2
  capture_sha256: 9f04011730d09b1e71f7e7b3144aff32bfeb360dd12114b2a2b9d53e0bb200c3
related_records:
- MOD-context
---

用户要求在长历史压缩前先显示本次输入，并在其下方展示压缩提示，主要面向 GPT 适配且不干扰 Sidechat 功能迁移。定位到引用预算在正式消息提交前等待，所以 GPT 展示之外需要 Core 的可选发送生命周期接口。

为保持新 GPT 插件的启动资格，extension-gpt-compat 的精确版本名单新增 0.5.0-dev.7，未知版本仍拒绝。Engine 升为 0.1.33-rc2.36，重新构建主引擎、独立格式 worker 与绑定工厂，刷新构件回执并通过正式 repair 更新实例绑定。插件保持 0.2.26-rc2.28。没有修改会话格式、恢复或派生算法。

设计边界：预览明确标为“发送准备中”，并不提前把未通过预算的输入当作正式历史。原输入和当前引用仍在旧历史压缩后正式注入。进度不写入模型历史或 Maintenance 真源。最初探索用 context/operation 承载展示状态，类型检查确认 kind 受格式严格限制，故改为内存状态和鉴权读取；没有新增私有会话事件。

并行任务已经部署 Core .18 并在源码准备 .19，因此本次部署基于安装包制作增量，只变更后端通知和版本标识，保留现有客户端字节。GPT dev.7 初次启动被 Maintenance 的版本名单拒绝，补齐格式兼容验证后更新 Engine .36 和正式绑定，没有绕过校验。

验证：GPT 75 项通过、1 项真实网络测试跳过；Core 通知与 Remote 9 项通过；Maintenance 格式适配 10 项通过；类型检查及构建通过。真实实例 run-96283763-d6f6-4d4d-9935-29456a9877e8 已运行，实际进度接口 200。独立浏览器使用仅作用于测试页的模拟响应验证第 2 段、等待时间、持久失败提示、成功后移除预览，页面脚本错误为 0；查看截图确认输入在上、状态在下。没有代用户提交消息或进行真实付费长压缩。UI 预览位于会话底部、输入框上方，正式消息由原发送流程接替。

## 原生压缩轨迹版本兼容

用户确认 GPT 压缩改为 DSH 原生事件轨迹。Engine 0.1.33-rc2.37 将 GPT 0.5.0-dev.8 加入 extension-gpt-compat 验证名单；保持既有 context 操作、结果和 checkpoint 格式、回收及投影规则不变。GPT 提供的界面投影不写入模型消息。10 项格式适配测试及引擎类型检查通过。此前来源索引对应前一阶段；本次依据当前任务确认与验证结果补充。

部署验收：旧运行正常退出并 recovered，升级 Engine .37、独立格式 worker 和绑定工厂，刷新 19 项完整性回执并通过官方 repair 更新启动绑定；副本 connected 且 issues 为空。GPT 实际会话 4 条历史轨迹刷新后仍可见。仅升级 GPT，保留并行任务已部署的 Core .19、Sidechat、Sticker 和 ThoughtDAG。

交付记录（2026-09-18）：Engine 0.1.33-rc2.37 已启用，Maintenance 插件保持 0.2.26-rc2.28；兼容提交 47cc1c0a73cbb1079d8c480d965d4a5696a1a98f 已推送至 codex/image-startup-recovery-20260917 并核对远端。部署时旧运行 run-96283763-d6f6-4d4d-9935-29456a9877e8 已回收，新运行 run-91ff1a36-7421-4021-a1d7-76d9e98a783b 已启动。用户要求本轮仅补开发日志，未修改功能文档或代码。
