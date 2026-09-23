---
id: HIST-startup-recovery
kind: history
title: 从未回收会话报错到自动恢复启动
date: 2026-09-19
status: current
modules:
- 宿主接入
- 运行时投影与兼容校验
summary: 实现正式恢复前置、修正生产包构建并刷新升级后的接入回执，最终启动通过。
outcome: 已安装激活，用户反馈没问题；保留退出不明与视觉未验收边界。
applicability: Windows Launcher 3ee0c44 与 Maintenance b7af3b8，.41 兼容组合。
coverage_note: Codex 根据本任务公开消息及工具回执整理，覆盖源码实现、安装重试、激活和用户确认；索引不复制载荷。
history:
  path: history/startup-recovery-20260919
  sha256: 86590b61ca4e6c7c97bb7db42e75b4885d796a2d62814521dfb275ae03577a56
  capture_sha256: c054dbf1793237b4c07b3fef2a4d9e048d2fecdef05479d1cb0462e0e9e59f6d
related_records:
- REQ-startup-recovery
- MOD-runtime
---

# 从未回收会话报错到自动恢复启动

用户不希望每次遇到旧运行都手动处理，确认仅在 Launcher 与 Maintenance 生命周期内补齐自动恢复，不改引用、贴纸或侧栏业务。实现使用可证明的退出证据及原 owner 的正式 Broker 恢复，并记录新进程身份。

首次备份后已完成真实旧运行恢复。用户退出 Launcher 后安装；第一次构建只用了 `cargo build --release`，遗漏 Tauri 正式页面协议，启动验收未进入实例流程。补充 `--features tauri/custom-protocol` 后重新构建，用户再次正常退出后替换，未强杀进程或伪造运行状态。

第二次启动成功进入恢复前置阶段，但旧能力回执绑定了先前 Launcher 指纹，准备步骤被接入校验拦截。临时诊断仅用于确认错误，随后恢复原配置。核对原构件、备份回执后，正常排空并切换 Maintenance Engine，更新本次 Launcher/Engine pin，通过正式 repair 接口重新验证。接口规范化了 Windows 路径分隔符，初次字节比较因此不相同；核实解析后的路径及其他字段一致后通过语义校验。

最终正式 Start 得到已核验的实例及维护 run，handle 写入新进程身份；用户反馈“没问题”并要求提交及更新地图。12 项恢复测试与 29 项 Launcher 测试通过；原 Provider 套件三项 Alpha2 失败在未修改基线上复现，未更改 Adapter 来掩盖。恢复进度视觉没有单独验收，同次开机内根 PID 消失而无退出证明仍不能自动恢复。
