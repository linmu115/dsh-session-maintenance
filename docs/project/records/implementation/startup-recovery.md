---
id: IMP-startup-recovery
kind: implementation
title: 启动时自动处理已退出的旧运行
status: current
progress: implemented
summary: Launcher 先请求正式恢复，成功再启动；无法确认退出时保留数据并说明原因。
relations:
- relation: implements
  to:
    record_id: REQ-startup-recovery
- relation: consumes
  to:
    record_id: IF-runtime
sources:
- path: ../reports/2026-09-19-startup-recovery-activation.md
---

# 启动时自动处理已退出的旧运行

用户点击 Launcher 启动时，先显示“正在恢复上次运行…”。Maintenance 按稳定实例 ID、profile 和原 owner 查找未收尾运行；证明其已退出后，调用正式 Broker 恢复，收到完成及清理回执才继续准备和启动。成功不再弹出“未回收会话”错误。

例如电脑重启后遗留的旧运行，可以依据系统启动时间与旧运行/handle 创建时间确认已退出。若同次开机中只有根 PID 消失、没有进程树退出证据，则不能推断其子进程也已结束，仍需提示原因。非 Windows 暂无该操作系统身份探测。

新运行记录 PID、进程创建时间和系统启动时间；正常退出路径先保存退出证据，恢复失败保留凭据供下次重试。活跃进程、身份冲突、缺失凭据或不完整回执均不会被自动删除或改状态。真实恢复写入沿用 Broker，元数据查询保持只读。

两个新增阶段 `recoverBeforeStart`、`started` 由独立开关启用，旧 Provider 默认不接收。`prepare` 也执行恢复检查，为旧 Launcher 保留兼容入口；完整进度及新运行身份登记需要匹配的 Launcher。

2026-09-19 已安装 Maintenance `b7af3b8`（.41 兼容组合的 startup-recovery 修订）和 Launcher `3ee0c44`。该本地部署来自 `codex/startup-recovery-20260919`，不能把另一工作树的 HEAD 当作已安装源码。Dashboard 及其他 26 个发行文件保持原哈希，引用、贴纸、思维图、BetterSidebar 和业务 Adapter 功能未改动。验收见 [[VER-startup-recovery]]，过程见 [[HIST-startup-recovery]]。

正常停止仍需 flush/drain/close 与 closed 回执；外部 Stop/Restart 入口仍未开放。自动恢复路径允许正式 recovered 回执，不改变正常停止标准。

2026-09-19 后续：原b7af3b8已通过3d96036合回Vault绑定/UI所在的发行分支，并随Engine .46激活；详情 [[HIST-recovery-regression]]。
