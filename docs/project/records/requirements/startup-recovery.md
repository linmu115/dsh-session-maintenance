---
id: REQ-startup-recovery
kind: requirement
title: 安全恢复旧运行后再启动
status: current
summary: 正常启动可回收旧运行时，须基于退出身份和正式恢复回执继续；活跃或不确定状态给出阻断原因。
---
用户曾确认点击启动时自动检查旧运行：证明旧进程退出且正式恢复成功后继续；旧进程仍活跃、退出不确定或恢复失败时保留原状态并说明原因。端口失联和根 PID 消失单独不足以证明可回收，不能杀进程、删锁或直接 runtime shutdown 代替 Launcher 停止。近期用户要求撤回未经授权的 Launcher 重构；此要求记录产品目标，不授权改写 Launcher 本体，Maintenance 与 Launcher 的具体交互只应由适配层承担。历史验收记录对应旧构件，当前 Launcher 集成状态需另核。旧来源：`d3fdbe3:docs/project/records/requirement/startup-recovery.md`。
