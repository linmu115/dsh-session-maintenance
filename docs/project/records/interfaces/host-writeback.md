---
id: IF-host-writeback
kind: interface
title: 宿主独占写回与回执
status: current
summary: Engine 把目标投影和已核验身份交给运行中的宿主；宿主独占写入、刷新并返回逐会话回执。
sources:
  - role: contract
    workspace_id: source
    path: packages/contracts/src/host-workspace-sync.ts
  - role: provider
    workspace_id: source
    path: plugins/dsh-session-maintenance/src/host-workspace-sync.ts
  - role: caller
    workspace_id: source
    path: packages/instance-integration-dsh/src/host-workspace-sync.ts
---
使用者提交本次操作 ID、实例/Profile/Home、PID/开始时间、选中的规范投影和策略版本。宿主核验自己仍是该目标后，禁止范围内新增写入，正常 flush 与 drain 已有会话，取得官方持久化写锁，核对变化，写入原生文件并同步归档/取消归档，刷新宿主读状态及插件数据，最后释放访问权。

返回的回执必须对应同一次操作和进程身份，包含目标会话映射、写入/未变化/失败统计。Engine 在确认完整回执及真源版本、选择范围未改变后登记绑定。任一阶段发生 DSH_BUSY、来源变化、身份不符、恢复不完整或回执缺失，不能假定成功；宿主保留隔离/重试条件，调用方不得绕过宿主直接覆盖运行中的文件。

这个合同的宿主细节由 [[MOD-dsh-host]] 提供，规范同步只依赖成功或失败的语义。修改它会同时影响实例插件、DSH 集成包、Engine 端点同步和插件恢复适配器。
