---
id: DEC-sync-authority
kind: decision
title: 实例目录接入与同步范围权威
status: current
summary: 通过 DSH Home 根目录和稳定身份连接实例；未显式选择同步工作区即为空，范围外实例数据不进入真源也不被覆盖。
---
目录连接选择 DSH Home 根目录，而非 profile 目录；同一 Home 中各 profile 分别核验，重复来源按 `(instanceId, profileId)` 合卡。Launcher 可作为兼容来源，但不是接管前提。实例侧显式加入的工作区与 Maintenance 保存的同步选择分别记录；旧“自动登记新工作区”和“无记录等于全选”已被用户撤销。已选择范围接管前按真源覆盖，接管后实例变化可上报；归档与取消归档对称。覆盖由宿主 adapter 写入实例活动会话目录并通过读取回执确认，不能让核心拼 DSH 路径。

此决定与旧持久原生空间规格中“未解决恢复就拒绝任何覆盖”的一句发生范围冲突；实际写入仍需独占屏障和恢复保护，不等于允许并发覆盖。实现状态按 [[MOD-endpoint]]、[[MOD-dsh-host]] 和 [[IF-host-writeback]] 逐项核对。旧依据：`d3fdbe3:docs/project/records/decision/directory-connect-sync-authority.md`。
