---
id: HIST-offline-vault-binding
kind: history
title: Vault 绑定从在线 DSH 动作迁到 Maintenance 管理
status: current
date: 2026-09-19
summary: 实例目录、绑定卡片和独立授权实现完成，保留 Obsidian 桥唯一写入与 CAS。
outcome: 代码、构建和合成验收完成，未部署真实安装。
applicability: 当前Maintenance工作树与Obsidian Bridge候选0.7.0-rc2.4。
coverage_note: Codex据当前任务用户要求及公开开发过程整理；索引第286至605行，96公开事件，截点1条调用未配对，后续报告与提交为补充。
related_records: [REQ-offline-vault-binding, MOD-business-pages, IF-offline-vault-binding]
history:
  path: history/offline-vault-binding-20260919
  sha256: 815b3584cd337b9610db18a0e6bf5b7e26c9dd25e87d32cf46195892c397cdc8
  capture_sha256: dfd5c8dbf9f07d9d094523c132e5a994281c740a46ca2ec6df2ba06c2c8d385a
---

# 用户修正与实施

用户要求绑定管理在Maintenance内完成，不依赖DSH启动；先实例，后绑定卡片，Vault逐行解绑，右上新建调用本机文件夹选择。旧流程由在线DSH Bridge贡献信息页、再核验live DSH身份，不能仅换UI实现离线目标。

新增Maintenance实例/列表/操作接口及专用授权，复用桥的持久写入、CAS和幂等。已知Vault离线可显示；DSH离线不阻止操作，但Obsidian Vault仍须在线。目录路径证明防止复制vaultId误绑定；浏览器不持有授权密钥。首次类型检查发现可选字段与React ref初值不匹配，修正后通过；检查真实API时发现卡片的name字段会混入严格查询，改为只传稳定instance/profile并补HTTP回归。

用户进一步要求不允许协同、有问题直接问用户。此前只回应过外部任务的修改范围通知，没有委派代理；此后未再协同。当前任务没有修改正在迁移的Suite或旧统一桥仓库，所需合同与记录保存在Maintenance与Obsidian桥本项目。

# 实际结果与边界

Maintenance相关23项、Obsidian桥相关21项通过；类型检查及双方构建完成。浏览器合成验收检查实例列表、弹窗、新建和逐行解绑。系统文件夹选择框与真实Vault写入未验收，未替换生产安装，未停止运行实例。详细报告见 [变更与验收](../../../changes/2026-09-19-offline-vault-binding.md)。
