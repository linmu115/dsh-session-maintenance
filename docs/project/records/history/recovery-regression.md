---
id: HIST-recovery-regression
kind: history
title: 升级遗漏启动恢复补丁与外部浏览器目录失败
date: 2026-09-19
status: current
modules: [宿主接入, 扩展数据]
summary: 用户反馈暴露升级遗漏，合回恢复协议、修复目录失败状态并增加有界请求头兼容。
outcome: 正式启动成功，内置浏览器目录可展开；外部原始431页面未完成视觉复测。
applicability: Engine 0.1.33-rc2.46 与 Dashboard 0.1.9。
coverage_note: 本任务公开用户消息及工具回执，范围1396至1721；仅保留来源索引，不复制载荷。
history:
  path: history/recovery-regression-20260919
  sha256: b081f905922d86cef7ec3e46f293def296548e68661c0090f902206f180a3411
  capture_sha256: 4087fadf8f6862fd09536be4aaa06c2b5669a0acd35a92a1fbad0962daec907a
related_records: [REQ-startup-recovery, VER-startup-recovery, REQ-sync-extension-navigation]
---

# 升级遗漏启动恢复补丁与外部浏览器目录失败

用户先指出没有可展开的工作区，再询问是否因实例没启动并报告Launcher无法启动。只读身份核验确认Engine ready、Launcher进程存在但副本stopped；目录认证请求三个Adapter均200。恢复浏览器登录后在实例停止时看见真实工作区，否定“必须先启动实例”的解释。用户补充431来自外部浏览器，Edge连接两种入口失败，内置浏览器正常。

启动trace表明失败在recoverBeforeStart。当前.45源分支缺少另一个已完成任务的b7af3b8补丁，先前升级没有保留已安装能力。合回原提交后24项生命周期测试通过，不修改停止和恢复安全判断。

目录UI增加错误/空结果/加载状态及重试，避免失败时仍提示展开。针对同主机跨端口累积Cookie，将请求头限制从Node默认16KiB调整为有界64KiB；合成大Cookie请求正常，非法来源和缺CSRF仍被拒绝，超过64KiB仍431。没有获得Edge原始请求，因此仅将Cookie作为有证据的相关触发机制，不宣称已确认外部根因。

切换发行先备份、核验无活动任务并正常排空。部署中分别修复回执BOM读取和.46接入枚举遗漏后成功激活，未绕过失败校验。正式Start确认副本和run running；内置页面实测工作区展开到会话及条目。详见[变更与验证](../../../changes/2026-09-19-recovery-regression.md)。
