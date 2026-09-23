---
id: MOD-dsh-host
kind: module
title: DSH 宿主与格式适配
status: current
summary: 处理 DSH 身份、Home/Profile、原生格式、宿主写入权、工作区路径、归档和刷新回执。
relations:
  - relation: provides
    to:
      record_id: IF-host-writeback
    reason: 提供端点对齐所需的安全宿主写回
  - relation: consumes
    to:
      record_id: IF-endpoint-sync
    reason: 实例变化通过端点协议回传
sources:
  - role: implementation
    workspace_id: source
    path: packages/instance-integration-dsh/src/host-workspace-sync.ts
  - role: implementation
    workspace_id: source
    path: packages/instance-integration-dsh/src/host-write-barrier.ts
  - role: implementation
    workspace_id: source
    path: plugins/dsh-session-maintenance/src/host-workspace-sync.ts
  - role: implementation
    workspace_id: source
    path: packages/adapter-dsh-0-1-5/src/index.ts
---
`packages/instance-integration-dsh` 发现并核验实例，处理物理 Home、Profile、工作区路径和向宿主提交完整写回请求。`plugins/dsh-session-maintenance` 在运行中的 DSH 内提供会话变化上报、工作区加入、归档状态及受保护的写回入口。`packages/adapter-dsh-0-1-5` 解读当前原生日志格式；旧格式适配包仍在仓库，但不自动等同于当前 RC2 宿主。

宿主写入前验证实例、Profile、Home、PID 和进程开始时间。屏障阻止目标会话的新写入，等待已有持有者正常排空，再持有宿主锁写入、刷新、回读，最后释放。忙碌、变化或回执不符时不承诺成功，也不把强杀进程视为正常停止。

这层包含 DSH 与可选 Launcher 发现/安装的具体知识；这些细节不应扩散到规范核心。当前装配根仍直接引用具体模块，见 [[ISS-remaining-coupling]]。
