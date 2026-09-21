# Session Maintenance

2026-09-20 源码候选的独立运行与接入边界：[[IMP-independent-components-20260920]]。运行副本尚未升级，历史记录按原验证范围阅读。

## 这个项目做什么

将 Codex 与 DSH 会话维护为有稳定身份、版本、来源和恢复证据的长期资料。Engine 管规范历史及业务对象，平台 Adapter 处理宿主格式，扩展 Adapter 解释引用、贴纸、链接、主干和 GPT 插件状态。源 Codex 日志与 Vault 笔记各由原平台拥有。

本项目独立维护，ID 为 `0d05f813-7097-47d9-9e88-3d523bb537d6`。DSH–Obsidian Suite 与 ThoughtDAG 是外部协作者，各有独立地图。

## 按问题阅读

| 想了解什么 | 入口 |
| --- | --- |
| 能做什么、现在怎样用 | [当前能力](../../README.md#%E5%BD%93%E5%89%8D%E5%8A%9F%E8%83%BD)、[使用流程](../../README.md#%E4%BD%BF%E7%94%A8%E6%B5%81%E7%A8%8B)、[当前实现](records/implementation/IMP-current.md) |
| 身份、版本、真源与写入权 | [会话与工作区身份](records/objects/overview.md)、[版本与续接](records/objects/versions.md)、[对象归属与写入权](records/objects/extensions.md) |
| 启动时自动恢复旧运行（已安装） | [[REQ-startup-recovery]]、[[IMP-startup-recovery]]、[[VER-startup-recovery]]；过程 [[HIST-startup-recovery]] |
| 普通插件增删升级为何不能拦住启动（本轮实现，未发布未验收） | [[IMP-startup-gate-split]]、[[VER-startup-gate-split]]；过程草稿（未绑定事件索引）[2026-09-21 历程](history-drafts/2026-09-21-startup-gate-split.md)；问题登记见[插件自由组合问题](../../issues/2026-09-20-managed-plugin-composition.md) |
| 实例先启动、引擎后接管并覆盖式同步（部分实现，全部未验收） | [[REQ-detached-instance-attach-sync]]、[[DEC-directory-connect-sync-authority]]；源码已部分落地（未推送、未进发行包、未做真实实例验收）；实例侧启动门按用户决定未动 |
| 非维护工作区的会话不进真源，但在 DSH 里照常对话 | [[REQ-detached-instance-attach-sync]] 第 12 条（已实现，仅合成测试） |
| 内部责任及生命周期 | [Engine 编排](records/modules/engine/overview.md)、[宿主接入](records/modules/host/overview.md)、[维护看板](records/modules/dashboard/overview.md) |
| 接 Codex/DSH 平台 | [平台适配](records/modules/adapters/harness/overview.md) → [平台合同](records/modules/adapters/harness/contract.md) → [平台已知接入](records/modules/adapters/harness/connected.md) |
| 接业务插件 | [业务数据适配](records/modules/adapters/business/overview.md) → [对象合同](records/modules/adapters/business/contract.md) → [业务已知接入](records/modules/adapters/business/connected.md) |
| 主干、引用与释放怎样协作 | [主干与固定引用](records/modules/engine/graph/contract.md)、[原生上下文释放](records/modules/engine/native-context/contract.md) |
| GPT 插件接入与本次误解 | [[INT-gpt-format]]、[[HIST-gpt-extension-boundary]] |
| 学习会话双端交接（实验，已部署并关联） | [[REQ-learning-roundtrip]]、[[IMP-learning-roundtrip]]、[[VER-learning-roundtrip]]；修复过程 [[HIST-learning-association-repair]] |
| 业务插件信息页与实例分类工作区范围（本地实现与验证完成） | [[REQ-extension-pages]]、[[IF-extension-pages]]、[[IF-instance-workspace-scope]]；历程 [[HIST-extension-pages-vault-binding]] |
| 跨项目完整确认稿 | [DSH–Obsidian 与 Maintenance 完整需求](../../../dsh-obsidian-session-reference-suite/docs/2026-09-18-dsh-obsidian-confirmed-requirements.md)；外部提供方维护自己的合同；SM本轮真实状态见 [[IMP-sync-ui-release]] 与 [[VER-sync-ui-release]]。 |
| 同步与扩展层级、安装后哪些生效 | [[REQ-sync-extension-navigation]]、[[IMP-sync-ui-release]]、[[VER-sync-ui-release]]；这些是旧版验收；当前部署见 [[VER-startup-recovery]]。 |
| 旧设计哪些有效 | [规格继承](records/decision/authority-history.md)；2026-09-21 实例接入与同步权威的新决定 [[DEC-directory-connect-sync-authority]] |
| 这次验证了什么 | [本次地图验证](records/verification/VER-adoption.md)；历史产品证据 [原生上下文历史验证](../changes/2026-09-15-native-context-management.md#%E9%AA%8C%E8%AF%81%E5%AF%B9%E5%BA%94)、[目录与阅读器历史验证](../reports/2026-09-15-extension-ownership-reader-release.md#%E9%AA%8C%E8%AF%81%E4%B8%8E%E9%83%A8%E7%BD%B2) |

架构图以责任边界展示内部模块与接口；流程图只画实现可证明的交接。A/B 共用本地图，B 可展开目录按责任定位记录。

## 维护约定

重启重复会话、归档还原与旧派生标题修复：[[IMP-recovery-archive]]；开发历程与来源：[[HIST-recovery-archive-title]]。

原需求、合同及交付报告保留原位置和编号。提供方技术合同只维护一份，消费者说明具体调用能力；记录和节点绑定随相关事实更新。diagrams 是原生图源，views 是带指纹的按需快照。普通维护不新增更新记录，不要求每轮读全图、重测产品或做成本基准。

## 当前实现与验收边界

当前维护引擎为 **0.1.33-rc2.53**，Dashboard **0.1.13**。学习双向维护已完成真实关联、自动退出普通 Codex 同步与零增量交接；发送按新增消息计算预算，不自动跳转或发起回答。2026-09-19 18:20 正常重启后接入 connected，交接仍为等待回收，历史与派生数不变。真实新增问答完整往返仍未验收。当前用法见 [[IMP-learning-roundtrip]]，证据见 [[VER-learning-roundtrip]]。

2026-09-21 启动门分离（MNT-001）：普通业务插件的增删升级不再计入启动绑定，普通插件组合单独记录为 `pluginInventory`；生效的用户 patch 层与接入插件自身身份仍在合同内。实现见 [[IMP-startup-gate-split]]，证据见 [[VER-startup-gate-split]]。**未提交、未构建进发行包、未做真实实例验收**；本机安装的发行版引擎（.58 / 接入 .36）不含此修复。

同一轮用户提出新架构要求：实例先启动、引擎后启动，引擎启动后自动检出已启动实例并连接，随后经实例侧插件确认执行真源同步，引擎缺席期间已勾选工作区内的实例侧改动由真源覆盖。已登记为 [[REQ-detached-instance-attach-sync]]；当前实现与该要求相反，实例侧 `plugins/dsh-session-maintenance/src/registered-startup.ts` 会抛错阻止加载，尚未开始实现。

2026-09-21 该要求的边界由**用户在 DSH 会话中的注释**逐条确认（不是模型推断）：插件侧在引擎缺席时留下可供引擎发现的握手/租约；引擎侧接管**不得依赖 Launcher**，改为像 Vault 绑定一样**选择实例文件夹**接入；来自 DSH 侧的真源改动**只**依赖**已绑定**实例在**同步工作区**内产生的会话改动，同步工作区**默认全部不勾选**，实例自带工作区是该实例的自有工作区（其中的会话不受影响），需在**原本的右键操作菜单**选「将当前工作区加入 sessionmaintenance」，由引擎启动时接纳，并在 Maintenance 自有会话存储区为该工作区新增文件夹、把 DSH 会话映射成自己的存储形式；归档状态按真源对称覆盖（真源未归档则覆盖后恢复为未归档）；实施顺序为**先做引擎侧「检出 + 接管 + 覆盖同步」**（不需要重启实例、不挂 hook 即可验收），取消实例侧启动门排在其后。这替代了此前的「原生新会话登记进真源（`importDshNative`）」与「未完成恢复则拒绝覆盖原生目录」两条规则。决定与替代关系见 [[DEC-directory-connect-sync-authority]]（旧记录 [[REQ-runtime-workspace-creation]] 已归档）；全部能力**尚未实现、未验收**。

2026-09-21 同一会话的后续一轮，用户对上述要求又逐条确认与修正（同样是**用户在 DSH 会话中的回答**，不是模型推断）：接管后的「覆盖」**写回实例当前实际使用的会话目录**（本机为 `<DSH_HOME>\sessions\<工作区目录>\<会话目录>\session.v3.jsonl.zstd`），**刷新 WebUI 即可见、不需要重启实例**——用户据此否掉了「引擎只做真源覆盖、实例原生文件不重写」的框架；同步范围**不存在「历史默认范围／legacy all」，「未显式选择即为空」**，新接入与存量一视同仁，原先依赖「无记录 = all」的已接入实例升级后范围会变空直到用户在面板里勾选；选择实例文件夹的那一层确认为 **DSH Home 根目录**（含 `profiles/` 与 `sessions/`）并**在选择栏旁给出文字提示**；同一实例出现两张卡时按 `(instanceId, profileId)` **合并为一张卡**并标注连接来源（Launcher / 目录式）；「连接之后让 DSH 侧也提供修改同步范围的选项」记为**可选**，不是本轮必须实现。已核实 DSH 的 JSONL 持久化按需 `readdir` 列目录、没有启动期索引；**尚未实测**已打开会话是否被宿主缓存在内存里。全部能力仍未实现、未验收，详见 [[REQ-detached-instance-attach-sync]] 第 7–11 条与 [[DEC-directory-connect-sync-authority]] 决定一之二。

以下版本为各项能力当时的安装与检查时点，不替代上述当前引擎版本。

2026-09-21 同一会话的再下一轮：**用户在 DSH 会话中的要求**补充了「**非维护工作区里的会话不进真源，但在 DSH 里必须照常读写与对话**」（[[REQ-detached-instance-attach-sync]] 第 12 条）。只读核查结论：拒绝只发生在**运行期登记/提交**这一步（引擎抛 `SESSION_NOT_SYNCED`，`apps/engine/src/runtime-workspace-registration.ts:65`、`:76`、`apps/engine/src/instance-workspace-runtime.ts:47`），并经 `apps/engine/src/http/routes.ts:792` 转成 HTTP 409 只回给调用方；插件侧的运行期登记入口只有**显式的 `create-session` 知识操作**（`plugins/dsh-session-maintenance/src/session-knowledge.ts:37`），普通对话不经过它；写入侧的门对范围外目标**一律放行且不查引擎**（`plugins/dsh-session-maintenance/src/write-access-scope.ts`）。**未发现它会冒到用户面前或阻塞宿主会话**。合成证据 `plugins/dsh-session-maintenance/test/out-of-scope-conversation.test.ts`（3 项）与 `apps/engine/test/runtime-new-workspace.test.ts`（4 项）通过；**未做真实实例验收**。同一轮用户拍板第 3 条 (a)「原生新会话自动登记进真源」**保持现状、不改代码**——非维护工作区的新会话已在登记阶段被拒，该语义已不成立；「工作区加入时是否映射**已存在**的会话」这一边界也由用户答复为**一次性全量映射、之后增量**（同记录第 13 条）。

据此修正上两段的概括：本要求的**目录式连接与覆盖同步已在源码上部分落地**——引擎侧同步范围默认空并在登记阶段拒绝范围外会话、插件侧握手/租约、覆盖式写入器、自有存储映射、实例侧工作区级右键入口、写访问门重定义、单次接管（放宽「未完成恢复即拒绝」）。这些改动**只提交在本地分支，未推送、未构建进发行包、未做真实实例验收**；实例侧启动门 `registered-startup.ts` 按用户决定**未动**（[[REQ-detached-instance-attach-sync]] 第 6 条把「取消实例侧启动门」排在后面且用户已明确暂缓）。因此「全部能力尚未实现」不再成立，准确表述是**部分实现、全部未验收**。

Vault绑定不依赖DSH启动的新要求与候选实现：[[REQ-offline-vault-binding]]、[[IF-offline-vault-binding]]、[[HIST-offline-vault-binding]]。已随 Engine .45 / Dashboard .1.7 与 Obsidian桥 .4 安装激活，真实绑定写入和安装版UI未验收。


2026-09-19 真源名单显示改进：[[REQ-maintenance-source-list]]；实现与合成浏览器验收见 [[HIST-maintenance-source-list]]。此改动已安装到当前 Engine .45 / Dashboard .1.7；安装版视觉尚未验收。


[[MOD-instance-workspace]] 提供Maintenance自身分类工作区策略、每实例共享范围、run快照及可选host有效范围；配置保存后下次启动生效，当前run不换范围。Codex项目映射在同步的另一同级子栏目。[[MOD-business-pages]] 提供公开贡献注册、结构化栏目与持久动作回执，Dashboard按“扩展→业务插件→插件内数据/信息页”组织；SM是外部业务的可选维护能力。

2026-09-19 早先激活截点：本地部署为 Maintenance .41 兼容组合的 startup-recovery 修订（`b7af3b8`），配合 Launcher `3ee0c44`。已完成真实旧运行正式恢复、生产包安装、接入重新校验及新实例启动，新增进程身份记录。现有 UI、插件文件、同步名单与其他绑定保持不变。实现及验收见 [[IMP-startup-recovery]]、[[VER-startup-recovery]]；恢复进度视觉仍未单独验收。

早先 .38/.39 与 prepare 失败的记录属于历史截点，保留在 [[IMP-sync-ui-release]]、[[VER-sync-ui-release]]，不再作为当前安装状态。当前 Launcher 外部 Stop/Restart 仍不可用；正常停止要求 closed，启动自动恢复路径接受正式 recovered，均不得强杀、删锁或改数据库状态。

此前安装与推送收尾：Engine **0.1.33-rc2.45**、Dashboard **0.1.7**、Obsidian Companion **0.7.0-rc2.4**。扩展目录已解除无关GPT索引等待，真实返回三个业务栏目；独立绑定管理可在DSH停止时读取现有Vault。备份、正常退出、保留其他插件和只读检查见 [本次激活报告](../reports/2026-09-19-engine45-binding-activation.md)及 [[HIST-offline-vault-binding]]。Launcher已打开；DSH实例未启动，安装版UI、真实绑定写入仍未验收。

此前前端覆盖版本为 **Dashboard 0.1.8**（Engine仍为.45）：实例列表和绑定弹窗按工作台风格重新排布，已备份安装并完成实际浏览器的列表、弹窗、刷新/关闭及浅深色检查。此前“安装版UI未验收”是.1.7安装时点记录，本次已补查这两处；真实绑定写入和系统目录选择仍未执行。参见 [[HIST-offline-vault-binding]] 和 [布局报告](../changes/2026-09-19-vault-binding-layout.md)。

2026-09-19 升级回归修复：Engine .46 / Dashboard .1.9 已激活，恢复此前遗漏的 Launcher 启动恢复协议，正式 Start 与内置浏览器扩展目录展开通过；外部431已加入有界兼容处理，原始页面复测未验收。见 [[HIST-recovery-regression]]。

2026-09-19 DSH 设置面板仅保留“打开完整看板”；旧维护偏好和操作已移除，客户端热更新及HTTP资源已核验，详见 [[HIST-settings-entry]]。
