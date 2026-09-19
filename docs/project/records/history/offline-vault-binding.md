---
id: HIST-offline-vault-binding
kind: history
title: Vault 绑定从在线 DSH 动作迁到 Maintenance 管理
status: current
date: 2026-09-19
summary: 实例目录、绑定卡片和独立授权实现完成，保留 Obsidian 桥唯一写入与 CAS。
outcome: 代码已推送，Engine .45和Obsidian桥.4已激活，真实只读检查通过，安装版UI与绑定写入未验收。
applicability: 当前Maintenance工作树与Obsidian Bridge候选0.7.0-rc2.4。
coverage_note: Codex据当前任务用户要求及公开开发过程整理；扩大来源到第286至950行，192公开事件，截点1条调用未配对；此后地图与最终推送为补充。
related_records: [REQ-offline-vault-binding, MOD-business-pages, IF-offline-vault-binding]
history:
  path: history/offline-vault-binding-release-20260919
  sha256: 4bcb75f08f9b8538ab2902cdc045c8d6e16cbd3e318e3ca290cb2cf681cfc26f
  capture_sha256: a8b33016fdd91fadc95b713039f020297e2a018eff6b9de5d6ee27848fc43fd6
---

# 用户修正与实施

用户要求绑定管理在Maintenance内完成，不依赖DSH启动；先实例，后绑定卡片，Vault逐行解绑，右上新建调用本机文件夹选择。旧流程由在线DSH Bridge贡献信息页、再核验live DSH身份，不能仅换UI实现离线目标。

新增Maintenance实例/列表/操作接口及专用授权，复用桥的持久写入、CAS和幂等。已知Vault离线可显示；DSH离线不阻止操作，但Obsidian Vault仍须在线。目录路径证明防止复制vaultId误绑定；浏览器不持有授权密钥。首次类型检查发现可选字段与React ref初值不匹配，修正后通过；检查真实API时发现卡片的name字段会混入严格查询，改为只传稳定instance/profile并补HTTP回归。

用户进一步要求不允许协同、有问题直接问用户。此前只回应过外部任务的修改范围通知，没有委派代理；此后未再协同。当前任务没有修改正在迁移的Suite或旧统一桥仓库，所需合同与记录保存在Maintenance与Obsidian桥本项目。

# 实际结果与边界

Maintenance相关23项、Obsidian桥相关21项通过；类型检查及双方构建完成。浏览器合成验收检查实例列表、弹窗、新建和逐行解绑。系统文件夹选择框与真实Vault写入未验收，未替换生产安装，未停止运行实例。详细报告见 [变更与验收](../../../changes/2026-09-19-offline-vault-binding.md)。

# 用户授权安装与推送后的结果

用户进一步要求核对CLI改动、推送两侧源码、更新地图、替换当前安装并开启Launcher。确认CLI已在独立DSH Bridge的d3b21f7提交并推送，不与Companion混为一个仓库。网络直连失败后通过本机已配置代理完成推送。发行检查拒绝旧.30归档字节差异，配套包另升.31；现有兼容.29插件保留。

无活动run/job时正常退出旧Engine；首次路径分隔符误判未发信号，修正完整参数比较并验证后获得drain/owner-release回执。停止后连接文件按设计清理，部署辅助脚本改用已核验旧PID与正式回执。备份后激活Engine .45及Obsidian桥.4，官方CLI重载；校验原绑定、data.json、同步名单、profile配置和1166个其他插件文件未变。扩展目录单次6ms，三个栏目齐全；DSH停止时Vault可管理。Launcher已打开。真实浏览器控制连接失败，所以安装版UI和真实绑定写入继续标未验收。详见 [激活报告](../../../reports/2026-09-19-engine45-binding-activation.md)。
