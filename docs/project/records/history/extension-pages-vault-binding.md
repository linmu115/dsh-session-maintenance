---
id: HIST-extension-pages-vault-binding
kind: history
title: 公开业务栏目与实例同步范围的确认
date: 2026-09-18
status: current
modules: [业务扩展, Dashboard, 宿主接入]
outcome: 同步及扩展层级已修复并完成限定真实UI验收；Engine .39已独立安装未激活，正式停止协议仍阻塞完整重启。
summary: 用户将统一目录扩展为插件自主信息页，确认共享实例同步范围及未同步链接保留。
applicability: Maintenance 公开业务扩展和 Obsidian 可选接入，沿用当前数据与写入归属。
coverage_note: Codex于2026-09-18扩展同一任务公开来源至第9–5944行，共1559事件；涵盖需求、施工、部署、UI纠偏及独立安装。截点一条工具调用未配对；保留旧索引，不收录隐藏推理或复制消息正文。
history:
  path: history/20260918-binding-scope-ui-installed
  sha256: 11b23d87d51c00137a498a8c95e7a48d4667bf677424ba3388b7e135b0e6b344
  capture_sha256: 29729cd575fd4d8684472efd9b14b8ba467c4753099cf6160621c2ce6d2908a2
related_records: [REQ-extension-pages, REQ-sync-extension-navigation, IF-extension-pages, IF-instance-workspace-scope, VER-extension-pages-design, IMP-sync-ui-release, VER-sync-ui-release]
---

# 公开业务栏目与实例同步范围的确认

用户最初希望在扩展数据中管理实例与 Vault 绑定，并要求 Maintenance 与双侧插件可以分别安装。进一步批注明确信息页由各业务插件通过公开注册接口贡献，数据目录只是其中一个栏目。绑定能力由 Bridge 提供，Maintenance 保存维护登记并承载可选 UI。

[查看依据：初始目标](history-event:EVT-81d07c27242839b95925)

[查看依据：公开注册、栏目和独立运行要求](history-event:EVT-a6b6fe6fa122edaa171e)

对于不同实例可能选择不同工作区，用户确认同实例的各 Vault 共用全部同步范围；取消同步只提示当前实例未同步并保留链接。重新同步按原身份核验恢复，实际删除另行表示。

[查看依据：范围选择](history-event:EVT-a193f84726285801f6dd)

[查看依据：取消同步后的链接](history-event:EVT-faf13702b32783bc1295)

源码核查发现现有数据 Adapter 的注册基础和面板分组可以复用，但 extensionConnect 是完整名单上报；因此公共注册器须汇总各插件贡献，不能让一个插件的注册撤销其他插件。公开页面贡献与受信 Engine 数据 Adapter 的具体宿主不同，跨进程资源装载留在实施阶段确定。

用户后续要求整理需求和项目地图，并再次认可历史链接规则。形成 [[REQ-extension-pages]]、[[IF-extension-pages]] 与 [[IF-instance-workspace-scope]]；Bridge 的绑定与动态端口合同在 Suite 地图维护，双方只保留所消费接口。

[查看依据：整理授权与历史规则确认](history-event:EVT-55e4c3bcb5375635db5b)

本次没有定位并验证实际运行组合中“按实例勾选”的权威范围入口；历史 Codex 回写配置不等于该接口。这一项被记录为工程核查，不能声称新范围接口已经存在或另建竞争名单。文档验证与未执行的产品验收见 [[VER-extension-pages-design]]。

## 完整需求阅读入口

用户后续要求统一整理完整需求，并另行讨论 Core 与桥插件的组合。完整稿由 Suite 地图维护为跨项目入口，本项目通过已有设计和地图链接过去，继续拥有自己的公开扩展与实例范围合同。桥插件的合并建议尚未确认，不改变 Maintenance 独立安装和可选接入要求。

[查看依据：完整文档与架构提问](history-event:EVT-1ff80cd98322df6cdb24)

本次更新同一任务的公开来源范围，保留原索引；产品代码没有因本次文档同步发生改变。

## 桥公共能力收敛与实施顺序确认

用户明确笔记关联是普通贴纸业务，应继续保留；Bridge 暴露共用双向引用通道，由普通贴纸适配。用户同时确认纯笔记操作不必经过 Core 引用流程或 Maintenance。此前迁移笔记关联功能的建议撤回。

[查看依据：职责修正、分期及等待开工要求](history-event:EVT-7001997878bc8d33bea6)

顺序确定为先整合 DSH Bridge 和普通贴纸的已有接入，再在两侧 Bridge 实现 Vault 绑定与路由，之后新增 Maintenance 的业务 Adapter 和扩展信息页，未来专门操作通道最后再展开。新追问确认第一阶段只统一已有引用、回链、定位和解除能力，保留扩展位置。

[查看依据：第一阶段只整合现有能力](history-event:EVT-adbd0f0aa425de5f0771)

现有 Maintenance 贴纸、引用和会话定位接入必须在重构阶段保持可用，新 Adapter 后置不等于移除旧能力。先落实实施计划，只有用户明确下令后才开始产品代码施工；本次只修订文档与地图。

[查看依据：保留现有维护接入](history-event:EVT-fd7a27be9c986eb9d8e3)

## 开工、第一阶段验收与新增同步策略

用户明确下令按需求和执行规划开始施工，由主代理指挥 Astra 子代理，思考强度不超过 high。此前等待开工的约束已经满足，不能继续作为停工条件。

[查看依据：明确开工与代理配置](history-event:EVT-a4b93285e8682a319461)

施工核查发现当前源码没有每 DSH 目标实例的工作区选择，只有全部投影及独立的 Codex 来源名单。用户明确授权 Maintenance 新增自己的实例工作区会话同步选择，只有选中内容在 DSH 与真源间双向同步。它成为有效范围权威来源，Bridge 不另建名单。

[查看依据：新增每实例双向同步范围](history-event:EVT-7c5cd785972fbe658088)

首阶段将引用接入整合进 Bridge，普通贴纸保留关联业务并使用共享通道。聚焦修复独立 Sticker 可选服务访问和共享队列的跨 Profile 重试容量；Core 仍负责事务与补偿。桥、贴纸、兼容入口、Suite 和 Companion 相关本地测试通过，组合来源检查发现并修正了旧开发依赖，未部署真实应用。

[查看依据：首阶段验收与进入后续阶段](history-event:EVT-a059a28e5421ba36e9f7)

## 继续施工：分类范围与启动生效

用户明确选择保存后在实例下次启动时应用新的同步范围，当前运行继续使用启动快照，允许正在进行的会话完整保存。界面同时展示当前范围与已保存范围。

[查看依据：下次启动生效](history-event:EVT-dc47647e43307ad82c2f)

进一步核实后，用户确认同步对象为 Maintenance 自己的会话分类工作区，区别于 DSH 按文件夹路径显示的项目。未分类会话有独立选择；同实例所有 Vault 共用这一范围。

[查看依据：分类工作区语义](history-event:EVT-853cc1946e5b3ca9e0a7)

实施采用持久绑定修订、动态发现与端口重连、每运行范围快照、投影筛选及事务内回写复核。公开业务页使用声明式栏目与有界动作回执，绑定写入仍交给 Companion。实际改动和后续验证的提交、测试数与限制见 implementation / verification 记录；本历程截点不代表后续工具工作已停止。

## 真实页面反馈与栏目层级纠正

用户指出原实现把“插件信息”错误放到了全局扩展数据旁边，明确要求“扩展→每个插件→Obsidian内扩展数据/插件信息与接入并列”。实现依据注册元数据归类，保留旧Bridge兼容关联，切换保留未完成操作身份。Dashboard .1.4静态更新后，主任务实际检查了Obsidian与ThoughtDAG隔离、切回状态、1088px无横向溢出及无console error；这只覆盖对应导航和展示，不代表引用业务往返全部通过。

[查看依据：插件内并列而非全局并列](history-event:EVT-94d26715699378ff3594)

[查看依据：扩展层级实际验收](history-event:EVT-004a872b1a0bf1515453)

用户随后明确Codex与Maintenance选择应成为同步下的两个并列子栏目。改动将两份表单分成保持挂载的标签页，修复实例卡片padding和表单间距，切换不保存名单。真实UI验收确认双标签可读可切换、当前范围默认折叠；草稿保留和键盘关系由合成测试支持，不混作全部真实交互已测。

[查看依据：两类同步并列要求](history-event:EVT-c65481b741437769a9e0)

[查看依据：Dashboard .1.5已部署、Engine修复尚未生效](history-event:EVT-3c3517af7d08578cc636)

## 当前范围、独立安装和停止卡点

检查发现activeScopes来自全部未关闭run，含等待恢复/隔离的历史记录，解释31条相同web/revision0范围铺开。修复使用已有RuntimeBroker在线判断，保留不同run和历史冻结快照；没有按显示文本假去重。前端只有数据库run状态，不能据此补出真实在线事实。因此Dashboard .1.5先折叠详情，Engine .39修复待正常切换才会影响实际数据。代码与定向回归结果见 [[IMP-sync-ui-release]]、[[VER-sync-ui-release]]。

用户要求安装后，Engine .39严格校验归档路径/类型/hash并安装到独立目录，27个文件逐项核对，8份旧入口/配置备份且保持不变。当前引擎、lifecycle及attestation仍 .38，未进行热切换。公开主任务确认安装与激活分开，并要求通过Launcher正常停止实例后核对最终回执；现无已核验外部停止协议，不用直接shutdown、强杀、删锁或改数据库冒充正常停机。

[查看依据：安装后仍 .38运行与正常停止卡点](history-event:EVT-b7f4dd3da81ed43b34ea)

本次整理扩展同一来源索引至第5944行，之后的Bridge安装不凭推测写入SM事实；用户后续停止DSH不等于Engine已切换。旧段落描述的“待实现/未部署”保留当时语境，当前状态以新增implementation和verification为准。可选SM业务维护、Core运行时引用、Bridge通道与Vault真源仍各自拥有自己的职责。

公开来源截点后的补充回执单独由 [[VER-sync-ui-release]] 记录：08:31插件安装校验通过但未激活；08:32正式Start在prepare阶段exit1/invalid-json，主任务只读排查，DSH仍stopped，Engine .38就绪。该补充来自准确安装回执及主任务提供的Launcher trace时间点，不伪造本索引范围内的history-event，也不把早先UI验收误写为这次新启动恢复成功。


### 接入指纹修复（保留失败前因）

2026-09-18 08:40 UTC，确认prepare拒绝原因为保存的Maintenance接入fingerprint仍对应旧插件/profile配置；不是attestation构件失败。插件及patch升级使其失配，provider在stderr报错而stdout为空，外层才记录invalid-json。备份后通过正式integrations repair验证本目标，恢复connected/issues=[]，其他绑定、同步范围、profile包与配置均不变。证据：D:/AI/DeepSeekHarness-Plugin/artifacts/bridge-folder-binding-20260918/start-binding-repaired.json。随后单一控制方执行Start，08:41:53 prepare已成功；后续running身份仍需单独核验，不能以prepare成功替代。


### 正式启动结果

本轮正式Start最终成功：RC2副本/web为running，新origin为http://127.0.0.1:27583，boot为05c53aef-7f18-465e-b773-1fc7750b66e7，run-2f0d3ad7-9778-43fc-857b-c6258c9ecc22为running，Engine ready，all/revision0。端口仅本次证据，不写入固定绑定。准备完成至web入口约40秒；旧boot日志不能归入新启动故障。运行恢复不代表外部浏览器bundle根因、真实folder绑定或所有引用交互已通过。Engine仍.38，.39未激活。
