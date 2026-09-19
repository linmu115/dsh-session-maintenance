---
id: VER-startup-recovery
kind: verification
title: 启动恢复的测试、安装与真实运行验收
status: current
summary: 自动恢复测试与真实启动通过；保留原有三项基线失败及视觉未验收边界。
relations:
- relation: verifies
  to:
    record_id: IMP-startup-recovery
sources:
- path: ../reports/2026-09-19-startup-recovery-activation.md
---

# 启动恢复的测试、安装与真实运行验收

适用提交：Maintenance `b7af3b8`；Launcher `3ee0c44`，正式构建说明 `8b9e6fe`。本记录描述 2026-09-19 的验收，不持续宣称某个 PID 或端口仍在线。

| 对象 | 结果 | 边界 |
| --- | --- | --- |
| 恢复机制 | 新增 12 项测试通过，Engine 类型检查通过 | 涵盖活跃进程、PID 复用、退出不明、重试、丢失响应、实例隔离、只读 SQLite 与 Windows 身份 |
| Launcher | 29 项生命周期及能力测试通过；前端检查及正式构建通过 | 正式构建必须启用 `tauri/custom-protocol` |
| 原 Provider 套件 | 9 项通过，3 项 Alpha2 Adapter 探测失败 | 未修改基线同样失败，不能报告全套通过 |
| 真实旧运行 | 备份后正式恢复，handle finalized、回执 recovered | 是真实 Provider 恢复；没有制造新的异常运行反复测试 |
| 新安装完整启动 | `recoverBeforeStart → prepare → started`，DSH 和维护 run 均 running | 身份、profile、home 与当次 boot 核验通过 |
| 新运行身份 | PID、创建时间、OS 启动时间写入 handle | 不代表所有异常退出情况均可自动恢复 |
| 组件保护 | 其余 26 个发行文件哈希相同；插件 pin、profile、同步名单和其他绑定不变 | 未重新验收每个插件的全部业务交互 |
| 界面 | 用户反馈“没问题” | 恢复进度的真实视觉效果未单独验收 |

实际 run 为 `run-719abe69-0938-4703-9dde-5751703310e2`；完整部署步骤、包哈希与本地回执位置见 [激活报告](../../../reports/2026-09-19-startup-recovery-activation.md)。历史 .38/.39 启动失败记录仍保留；当前部署入口以本条为准。
