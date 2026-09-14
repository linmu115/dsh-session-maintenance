# 0.1.5-rc.2 副本：系统运行性与设计规格审计

日期：2026-09-14。审计结论：**系统可以启动、读取会话并打开主要界面，尚不符合完整设计与功能验收要求。**归并为 2 项 P1 和 9 项 P2；其中新草稿误报发送成功、网络会话入口错误、迁移回执、预算表耗尽、启动全量读取均有实际界面或隔离复现。其余为有明确调用链证据的规格缺口，不能写成已在用户数据中发生的故障。

本次是检查与报告，不修改业务代码、插件配置或部署，不发送真实模型请求，不迁移真实 Vault。报告提交仅记录本次证据。

## 1. 范围与规格基线

目标为 Launcher 的 **0.1.5-rc.2 副本 / web**，实例 i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926。涵盖 Session Maintenance、Annotation、Sidechat、Sticker、Obsidian Lifecycle/Reference Adapter/Companion、ThoughtDAG 和 Codex Runtime；对其余已安装插件核查安装完整性，不代表每个第三方功能都完成专项业务验收。主实例只核查接入和配置一致性，未启动其它实例进行全量回归。

对照以下五份当前仓库文档，按 2026-09-14 的补充要求覆盖 P2/P4；早期文档中的“以后实施”是历史交付说明，不用于豁免用户后来已授权的范围。

- [2026-09-10-persistent-native-session-space.md](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-persistent-native-session-space.md)
- [2026-09-10-pluggable-extension-data-requirements.md](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-pluggable-extension-data-requirements.md)
- [2026-09-10-session-context-graph-requirements.md](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-session-context-graph-requirements.md)
- [2026-09-10-session-context-graph-plugin-changes.md](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-session-context-graph-plugin-changes.md)
- [2026-09-14-session-stickers-knowledge-network.md](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-14-session-stickers-knowledge-network.md)

精确源码提交、文档 SHA256 和工作树状态见 [audit-baseline.json](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/audit-baseline.json)。审计开始时 10 个相关仓库工作树均干净。

## 2. 实际运行检查

| 检查 | 本轮结果 |
|---|---|
| Engine 0.1.33-rc2.13 | health ready；安装入口哈希匹配发布回执 |
| Launcher 副本 | run-0a0ed332-f33f-4c10-a156-b5f29f63f11f 正在运行；实际地址 http://127.0.0.1:15655 |
| 插件安装内容 | 19 个包版本/归档哈希一致，987 个打包内容文件与已安装文件一致 |
| 扩展能力 | annotation-upstream、stickers、obsidian-links、thoughtdag 均 ready |
| Maintenance 数据库 | SQLite quick_check=ok；530 个会话版本头摘要与上次交付前一致 |
| 当前实例的持久原生空间 | 39 个受管原生文件全部存在，约 15.26 MiB；不是把 530 个真源会话都算成本实例文件 |
| 当前运行状态事件 | prepare/materialize/attach/flush 均有成功事件；未发现本次运行失败事件或未完成提交操作；任务队列无排队/执行项 |
| 真实业务读取接口 | 7 个工作区目录、39 个网络目录项、影响读取、ThoughtDAG maintenance 模式、Companion 协议均正常响应 |
| 实际界面 | 会话页、贴纸弹窗、思维图和全局网络可以打开；全局网络打开会话失败，见 F02 |
| 用户业务数据 | 当前新扩展域中会话贴纸和知识链接列表均为空，所以真实数据的贴纸/双链/迁移使用不能以空面板可打开代替验收 |
| 主实例 | Maintenance 接入仍 connected，三个被核验的 profile 文件与交付前一致 |

系统内保留历史 quarantined 运行记录；它们不是本次正在运行副本的新故障，也未在审计中清理。各运行文件和接口状态证据见 [runtime-audit.json](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/runtime-audit.json)、[native-state-audit.json](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/native-state-audit.json)、[live-endpoints.json](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/live-endpoints.json)。

## 3. 发现与修复顺序

P1 为应优先处理的输入正确性或主要入口不可用问题；P2 为功能、可靠性或明确规格缺口。排序表示建议修复顺序，不表示所有问题已在真实使用中触发。

| ID | 优先级 | 问题与用户可见影响 | 需求与证据 |
|---|---|---|---|
| F01 | P1 | 旧发送响应丢失后，用户修改草稿再发；若旧请求已 durable，客户端把新草稿也回报 success，却没有提交它。宿主会按成功消费新文字/附件。 | XR08/XR10、AC03/AC04/AC22；Core composer-binding.tsx:283–290、332–346；R1 隔离补测失败，submit 仅调用 1 次。 |
| F02 | P1 | 全局维护网络点击已在当前实例打开的会话，误报“会话未接入当前实例或已删除”。逻辑 ID 被传入只接收原生 ID 的桥接分支。 | P4 网络操作、完整会话跳转；ThoughtDAG dsh/lib/client.js:98–100；副本已实际复现。 |
| F03 | P2 | 初始引用问答材料只按模型窗口比例分配，未扣已有历史、系统/工具、本轮输入和输出预留。长会话可能在进入后续工具保护之前就超额。 | RD07；Core submit-annotated.ts:144–153、prepare-reference-set.ts:216–234；后续工具预算已有保护，问题限定初始阶段。 |
| F04 | P2 | stage A+B 后，activate 只带 A 仍成功；active 回执只记录 A，但 B 也变可见。迁移最后的完整集合核验缺失。 | AC17、P2 迁移写入权；M-01 隔离复现。未证明丢失正文或当前正常 UI 必然发出此请求。 |
| F05 | P2 | Engine 引用预算表的执行记录没有回收；达到 10000 个后，即使额度都已退还，新执行仍一直被拒绝，直到 Engine 重启。 | RD06/AC10、长期运行；M-02 隔离复现。不是当前已经耗尽。 |
| F06 | P2 | RC2 无变化启动在摘要比较前仍逐一读取会话全文做资源检查。文件复用正确，但未达到不读未变正文的性能目标。 | N02/N03；M-03 隔离复现，实际 RC2 资源钩子调用链确认。 |
| F07 | P2 | Obsidian 能按整篇笔记新建/关联会话，但“选段→创建/挂接会话贴纸”尚未连接到 stickers 对象和选区来源。 | OB02/ST02；R4 与图谱审计交叉确认。 |
| F08 | P2 | 已发送 Annotation 笔记引用的打开来源仍用旧 notePath；笔记改名后不走已有的稳定块/笔记身份解析。 | OB03/OB04、AC16；R3 调用链。新知识链接的 noteId 改名支持不能替代此入口。 |
| F09 | P2 | 笔记删除只改本地 missing，不立即同步 Maintenance；链接同步最多 600 条且每次从头开始，后续条目无法继续。 | 知识链接同步状态/分页可维护性；R5 静态证据。 |
| F10 | P2 | 画布旧固定材料展开要求来源版本等于当前最新版本；正常追加后，原固定版本仍在也不能按旧范围展开。 | GR02/CUT05/AC07；图谱固定材料预览调用链。固定上游引用工具本身未因此越界读取。 |
| F11 | P2 | 全局网络默认目录只列会话/画布/贴纸/笔记；已发送引用只能按某个来源查看出向影响，缺少独立引用搜索和完整入向关系浏览。 | 09-14 P4 全部已发送引用、来源/去向聚合要求；图谱子报告 P4-02。关系真源已保存，缺口在统一浏览与查询。 |

[真实副本网络跳转错误截图](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/network-open-failure.png)。其它问题的准确文件行、触发条件、测试和影响限制见后附三个子报告。

建议先修 F01，再修 F02/F03；迁移前修 F04，随后补齐 F05–F11。当前不应将“安装检查通过”或旧测试全部通过标成“完整功能验收通过”。

## 4. 会话上下文图 AC01–AC22 对照

“通过（合成）”只表示列明的实现和测试覆盖；没有把自动检查冒充用户实际验收。

| ID | 当前结论 | 说明 |
|---|---|---|
| AC01 | 部分验证 | 工作区先展示与按需目录已实现；实际读到 7 个工作区，长列表滚轮有合成覆盖，返回列表位置等完整交互仍需验收。 |
| AC02 | 未完成 RC2 全场景验收 | 本轮生成并 Codec 读取 205 份 RC1 文件；没有官方 RC2 大目录 list/readFrom 与跨会话 UI 冷会话验收。实际副本 39 个文件齐全。 |
| AC03 | 部分/存在缺陷 | 正常草稿附件保留测试通过；不确定回执后编辑重试有 F01。 |
| AC04 | 部分/存在缺陷 | 引用幂等、挂载、领取约束通过合成测试；新草稿恢复 F01 和网络跳转 F02 仍阻断完整认可。 |
| AC05 | 通过（合成） | 所选完整回复可读，未来轮次通过读取/搜索均被边界排除。 |
| AC06 | 通过（已测范围） | 完成点/源版本固定和未完成拒绝已有实现；真实流式失败、取消流程未在本轮操作。 |
| AC07 | 部分 | 固定引用追加后保持范围通过；画布固定材料旧版本展开有 F10。 |
| AC08 | 部分 | 初始问题+所选回答与超长继续游标已实现并通过；容量余量 F03 未补齐。 |
| AC09 | 部分 | 长单条和大工具输出的有界分页通过；模型实际余量仍受 F03 限制。 |
| AC10 | 部分 | 并发共享预算和重试不充值通过；长时间执行记录耗尽 F05。 |
| AC11 | 通过（合成） | 不自动递归展开，保留多来源，有环网络有界。 |
| AC12 | 未做真实模型验收 | 工具说明与读取记录实现存在；不能仅凭工具注册断言 AI 会正确主动使用和理解全部来源。 |
| AC13 | 通过（合成），实用验收待补 | 会话贴纸使用稳定真实会话身份、完整页打开、多位置不复制历史；实际扩展域当前没有贴纸对象。 |
| AC14 | 实现存在/真实模型未验证 | 使用目标 sessionController，Codex Runtime 26项合成测试通过；未发真实工具/模型任务。 |
| AC15 | 通过（合成） | 删卡片/解除一处知识链接不删会话和笔记正文；视觉呈现与语义关系分开。 |
| AC16 | 部分 | 新知识链接 noteId 解析/改名已具备；旧 Annotation 打开来源 F08 和选段入口 F07 未完成。 |
| AC17 | 部分 | 冻结、持久写屏障、导入正常路径和重复请求有测试；激活回执完整性 F04，真实跨库故障未验。 |
| AC18 | 通过（模块合成） | 扩展停用保留对象、缺 Adapter 提示与重新启用读取已测；本轮不热停真实插件。 |
| AC19 | 通过（实际配置+代码） | 副本原生文件在 Maintenance native-spaces 中，39份存在；ThoughtDAG通过当前实例接口发现。 |
| AC20 | 部分 | 新扩展对象未按轮次生成全文快照，分页和对象上限存在；预算记录无回收 F05，链接同步长列表 F09。 |
| AC21 | 通过（边界代码/合成），清理现场未验 | 固定版本缺失显式不可用，不偷换最新版本；没有在真实源库执行清理来破坏现有引用。 |
| AC22 | 不通过完整验收 | 已覆盖的发送拒绝/持久回执恢复通过，但 F01 说明改稿后重试仍有错误成功状态。 |

持久原生空间 N01–N13、扩展 E01–E06、RD01–RD12 和 P4 的更细映射在 Maintenance 子报告；贴纸 ST、Obsidian OB 和画布 GR 在另两个子报告。

## 5. 验证与尚未覆盖范围

本轮直接运行既有重点测试：Maintenance 33、Core/Adapter/Companion/Lifecycle 118、图谱子审计跨四仓库 50、Codex Runtime 26，合计 **227 次测试执行通过**；其中跨审计重跑了 Maintenance knowledge 的 1 项、Companion knowledge 的 6 项，按测试去重为 **220 项**。另外 3 项审计测试成功复现 Maintenance 缺陷，1 项按正确行为编写的草稿测试失败；二者都属于缺陷证据，不算功能验收通过。真实浏览器补充复现 F02。

上次交付的 19 插件官方宿主写入/冷读探针，以及 UI 主题、窄窗口、键盘检查作为已核对版本的既有证据保留，本轮没有把它们重复计入上述次数。没有完整重跑所有仓库的所有测试。图谱子审计 50 次执行的原始 stdout 保存在当时工具记录中，审计目录的结果文件为汇总而非原始日志。

仍需修复后单独验收：RC2 超过200冷会话；实际 Obsidian WebViewer 与独立窗口并存时的领取和延迟；用户真实模型发答及长上下文容量；真实 Vault 迁移、笔记移动和崩溃恢复；Alpha2/其它历史实例完整兼容。当前没有业务贴纸/知识链接可供非破坏性真实迁移验收，所以使用合成数据检查状态机，不能称用户迁移已通过。

审计产物目录：D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914。API 和浏览器只做读取与导航；没有暴露访问令牌、复制完整会话历史或新增上下文快照。

## 附录 A：Maintenance 子审计

# Maintenance 系统审计：持久会话、扩展数据、固定上游与知识网络

审计时间：2026-09-14。性质：只读源码/安装文件核验与隔离合成测试；未修改源码、安装配置、运行副本、真实会话、数据库或 Vault，未启动模型。新增文件仅为本审计目录的报告、测试与日志。审计前后 Maintenance 工作树均干净。

## 结论

核心机制有实质实现：稳定原生空间、恢复门禁、原生模式不再按需补写旧会话、独立扩展对象、冲突处理、固定上游边界、初始问答和长文本分页，以及有界知识网络。现有重点测试 7 个文件、33 项全部通过。

不能据此认定全部规格已满足。本轮另外用合成测试确认三个缺口：迁移激活未完整核对原暂存映射；引用预算记账没有已结束执行的回收机制；RC2 资源校验使无变化重启仍读取每份会话正文。这三项不是后续功能规划，而是已交付能力的正确性或运行效率问题。未发现本轮可证明的 P0/P1 级会话历史损坏或跨实例写入问题。

## 基线与安装证据

- 源码：`D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance`，HEAD `a68d0875fe3b6e85f08829d7a03c322a5f9fc1ae`。
- 安装 Engine：`0.1.33-rc2.13`，配套 Maintenance 插件 `0.2.26-rc2.9`。
- 已现场读取安装文件并计算 SHA256：`D:/AI/DSH-Plugin-Releases/maintenance/engine-0.1.33-rc2.13-plugin-0.2.26-rc2.9-3ea36dd6b146/dsh-session-maintenance/engine/dsh-session-maint.mjs` → `3b1ba75b1700b8d3097228e05cea191d88d9959ee4bb84ba371b63466794a041`，与 `artifacts/sticker-ui-dsh-20260914/engine-package-validation.json` 一致。
- 该部署回执记录 `sourceDirty=false`、内嵌插件与独立包一致；本轮核验确认安装文件仍为这份构建，但没有把旧部署回执中的运行状态当成现在的健康检查。
- 2026-09-10 的文档保留了最初“后续/未实现”等历史描述；P2/P4 当前范围以 `2026-09-14-session-stickers-knowledge-network.md` 的授权和要求为准。自动重新回答、跨实例网络、逐轮全文快照仍不属于当前要求。

## 已复现问题

### M-01 / P2：迁移可以在没有完整核对暂存对象集合时变为 active

关联：P2、AC17、2026-09-14 规格“核对回执 → 激活新写入方”“重复导入、崩溃恢复”。

源码：[session-knowledge-service.ts:83](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:83) 只固定 migrationId/sourceDigest/逻辑会话；[85](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:85) 从此次请求重新计算 mappings；[93](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:93) 只核对此次请求列出的对象；[97](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:97) 将它们写成 active 回执。缺少与原 staged mappings 的完整集合相等校验。

复现：同一合成会话 stage 两张旧贴纸 A+B；使用相同 migrationId、sourceDigest、sourceRevision，activate 时只带 A。结果请求成功，active 回执只含 A；B 也因 [activeImport:15](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:15) 仅检查相同 migrationId 已 active 而变得可见。

影响：回执不再完整代表已激活的数据，调用方收到部分或错误重试载荷时，后端仍可能完成写入权切换。此次复现没有丢失 B 正文，也未证明当前正常 UI 会发出这种请求；问题在迁移协议的最后一道完整性检查，不能把测试结果描述成已发生数据丢失。

### M-02 / P2：所有实例共享的预算表满 10000 个执行后，新轮次一直不可读

关联：RD06、RD08、AC10、长期运行可用性。

源码：[session-context-reader.ts:6](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-context-reader.ts:6) 的 executions Map 没有删除/结束接口；[11](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-context-reader.ts:11) 在 10000 项时拒绝新执行；[17](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-context-reader.ts:17) 的 settle 只退还预留字节、不释放执行记录。整个 [SessionContextService:11](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-context-service.ts:11) 生命周期复用一张表。

复现：创建 10000 个不同执行，每个 reserve 后立刻 settle(0)；第 10001 个新执行仍报“引用读取执行数量达到上限”，旧 key 仍能读取。未结束执行不可随意淘汰是正确的，但当前连未使用字节且已结束的执行也没有释放路径。到达门槛后，Engine 重启才会重新拥有空表；单纯开新会话/换实例不能解除这个全局门槛。

影响：这是长时间运行累积触发的可用性问题，不是现在每次请求都会失败。需要区分活动执行与已结束执行，并保留防止重放预算重置的机制。

### M-03 / P2：RC2 无变化启动仍把所有会话正文读一遍

关联：N02/N03、持久原生空间启动步骤 4、“未改变的会话不读取全部历史正文”。

源码：[native-space.ts:146](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/packages/projection-lifecycle/src/native-space.ts:146) 在每个条目的摘要比较前调用 `prepareResources(await directory.readSession(...))`；[151](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/packages/projection-lifecycle/src/native-space.ts:151) 才比较摘要，[156](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/packages/projection-lifecycle/src/native-space.ts:156) 才决定复用。RC2 在 [native-session-codec.ts:15](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/packages/adapter-dsh-0-1-5/src/native-session-codec.ts:15) 始终提供该资源钩子；无附件检查在 [portable-resources.ts:39](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/packages/adapter-dsh-0-1-5/src/portable-resources.ts:39) 才返回，已无法省去正文读取。

复现使用公共 NativeSessionSpace + 原 RC1 编码器 + 实际 RC2 资源钩子，以隔离确认调用顺序：三个无附件、内容不变、摘要一致的会话正常 checkpoint 后再次 prepare，readSession 调用 s0、s1、s2 各一次，原生文件 mtime 均保持不变。此测试不是完整 RC2 宿主性能压测；实际 RC2 注册同一钩子的源码证明它会走这条读取分支。

影响：正确复用原生文件、没有重新压缩写回，但 warm startup 成本仍随全部历史正文/附件字节增长。RC1 的既有 N02 测试使用不含资源钩子的 Adapter，所以“未变正文 readSession 零次”的测试通过，无法覆盖 RC2 的这项回退。附件完整性检查有必要；缺口是资源清单与整份历史读取尚未解耦。

## 需求对照

“满足”限定为本模块源码与列明的合成证据；副本 UI、模型行为、实际 Vault 迁移和真实崩溃验收由其它审计项或用户验收覆盖。

### 持久原生空间

| ID | 结果 | 证据与界限 |
|---|---|---|
| N01 | 部分 | 本轮实际运行 `native-space.test.ts:51`：生成 205 份 RC1 原生会话并经 Codec inspect 读取，包含 s204 冷条目。没有调用官方 Host 的 list/readFrom 完成同样的大目录验收；也没有重做 205 份 RC2 文件验收。运行副本只有 39 份原生文件存在的证据不能代替此项。 |
| N02 | 部分 | 原生根与未变文件 mtime 复用通过；RC2 无变化全文读取见 M-03。运行插件明确不安装 lazy 包装器：`plugins/dsh-session-maintenance/src/index.ts:131`。 |
| N03 | 部分 | RC1 仅变化会话重新编码/写回通过；RC2 不变文件仍资源正文读取，见 M-03。 |
| N04/N05 | 满足（已测范围） | `native-space.test.ts:75` 覆盖删除、恢复、空文件、cwd 变更；标题标签/目录由插件 metadata 恢复。`empty-projection-rc2.test.ts:11` 有不 create/append/hydrate 的 RC2 单元覆盖，本次仅静态阅读该测试。 |
| N06/N07 | 满足（RC1 合成恢复） | `persistent-native-runtime.test.ts:22` 正常关闭、已 attach 崩溃尾部均恰好一次恢复，根/mtime 保持；V3 自有恢复函数在 `runtime-broker.ts:463` 分派，不在本轮故意破坏运行副本。 |
| N08 | 满足 | `native-space.ts:113,200` journal 重放/原子替换；两个同步中断测试通过。 |
| N09/N10 | 满足 | `native-space.ts:35,104,127` 身份与前运行状态，`native-space.test.ts:91` 拒绝活动 owner、改写原生文件，隔离实例/profile/format。 |
| N11 | 未验证 | 当前任务未重跑 Alpha2/旧格式完整回归，不能从本轮 RC1/RC2 合成结果推导全部旧版本兼容。 |
| N12 | 满足 | `runtime-broker.ts:227` 要求 explicit persistent-native-v1 acknowledge；旧插件未确认模式时测试拒绝。 |
| N13 | 满足（RC1 合成恢复） | `persistent-native-runtime.test.ts:22` crash-before-attach 通过；Broker 对持久空间不走旧 prepared discard，见 `runtime-broker.ts:388,420`。 |
| AC02/AC19 | 部分（代码路径具备，副本操作未验证） | `runtime-stream.ts:200–202` persistent 模式 hotLimit=0；全目录仍发送元数据；`projection-runtime.ts:583,674` 全目录标记已原生就绪；root 来自 Broker 回执，未写死 DSH_HOME/sessions。本轮未通过跨会话引用 UI 在超过 200 条的 RC2 历史目录里选择冷会话。 |

### 可拔插扩展（本文 E 编号为审计映射，原扩展文档未分配 ID）

| ID / 对应要求 | 结果 | 证据 |
|---|---|---|
| E01 / D07：会话与插件对象分属 | 满足 | `extension-repository.ts:29` 独立 extension 表；`extension-data.test.ts:27` 两类对象往返不改 session 表。当前 Annotation 的上游语义域为 annotation-upstream，普通旧注释仍须按既有迁移规则处理。 |
| E02 / 两类 Adapter 独立 | 满足 | `extensions/service.ts:9` 独立 registry；`extensions/adapters.ts:24,49,66` ThoughtDAG、知识链接、贴纸各自 schema 和版本。DSH 原生格式仍在 adapter-dsh-*。 |
| E03 / D07,AC18：配置/停用/卸载 | 满足 | `extensions/service.ts:20–26` ready/disabled/missing-adapter/incompatible；`extension-repository.ts:46–64` configured/enabled 与数据分开；停用、卸载、缺 Adapter、重启保留测试通过。 |
| E04 / 对象写入权、预期版本和冲突 | 满足 | `extensions/service.ts:53–63` writer/capability/schema；`extension-repository.ts:87–104` 幂等、CAS、保留冲突；`service.ts:71` 显式解决。 |
| E05 / 按需正文、元数据分页 | 满足 | `extension-repository.ts:61` 分页仅 metadata；`extension-data.ts:31` 宿主 30 项；正文 get 单独调用。 |
| E06 / D08,AC20：无逐轮完整快照 | 满足（新增扩展数据路径） | `extension-repository.ts:29,80` 仅当前对象和未解决冲突，单对象 512 KiB、单对象最多 16 个未解决冲突、重复保存不增版本。不能据此替代原会话库自身容量审计。 |

### 固定上游与预算

| ID | 结果 | 证据与界限 |
|---|---|---|
| D03/D04,RD01/RD02,AC05–AC07 | 满足 | `session-context-service.ts:44–84` 固定已有 version/cutoff/digest；`:105–118` 查该版本与完成点；`:138` 先 slice 固定上限再给 Adapter。当前版本检查/追加后不越界/未来词搜索不可见测试通过。 |
| D05,AC08 | 满足（Engine） | `session-context-reader.ts:33–114` initial chronological selected-turn、优先 user+选中 answer、detailsCursor；大工具输出不挤掉回答；超长问答继续分页测试通过。Core 提交包络是否始终带入这些结果在引用子审计评估。 |
| RD03/RD12 | 满足（Engine） | `session-context-service.ts:13,24,88` 当前 run+ready namespace+目标逻辑身份验证；source/read 没有调用 source Agent 或任何会话写接口；HTTP 未认证拒绝测试通过。 |
| RD04/RD05/RD08 | 满足（分页主体） | 全序列化计量、UTF-16 对完整性、长内容游标、空内容前进、读完/仍有更多状态测试通过。初始包络转义与总体扣减还依赖 Core 本地额度，不能只看 Engine 响应大小宣称模型永不超限。 |
| RD06/AC10 | 部分 | reserve 同步共享 scope+target+execution 额度，重试/并发/变大参数不会充值；长期生命周期缺口 M-02。 |
| RD07 | 部分/需结合引用审计 | Engine DTO 只接受 maxBytes/totalBytes，并非自行知道目标上下文：`contracts/src/session-context.ts:28–34`；最大 16/64 KiB 不是模型剩余容量证明。Core 后续工具和初始 prepare 的模型预算逻辑应分别核验。 |
| RD09/RD10,AC11 | 满足（不自动递归）/索引复用未实现 | 每次只读当前 reference 的固定事件，不自动展开历史里的其它引用；多关系保留。source() 会加载固定版本事件后分页，未实现全局共同上游缓存；缓存是可选优化，不能误称已有。 |
| RD11 | 满足（接口上限）/模型适配见 RD07 | 捕获选文最多 16000 字符；后端返回还有字节限额。初始模型容量判断仍需要 Core。 |
| GR09 | 满足 | SessionContextService 的接入只检查 annotation-upstream，未依赖 ThoughtDAG；graph 服务也单独注册。 |

### 会话贴纸、链接与维护网络

| ID / 2026-09-14 要求 | 结果 | 证据与界限 |
|---|---|---|
| D01,AC13–AC15：真实会话身份、卡片不删会话 | 满足（后端） | `session-knowledge-service.ts:60–75` 保存逻辑身份并经 graph.resolve；知识对象写/删除不调用会话删除；既有 knowledge 测试会话数量恒定。主体点击、DSH Agent 运行由 UI 子审计/副本验收判断。 |
| OB01–OB06：双向链接与移动 | 部分（后端已具备） | `contracts/src/session-knowledge.ts:6–21` 稳定 noteId、路径、块/标题及 syncState；knowledge 测试更新 notePath 保持 noteId。Obsidian 原生笔记动作与双方跳转不在本子审计操作范围。 |
| AC17 / 迁移冻结、回执、切换 | 部分 | staged 数据不可见、重复导入、冲突、激活后独立保存/删除已有测试；激活缺少完整集合核对见 M-01。旧 Vault 写入冻结由 Bridge 负责，本轮不操作真实迁移。 |
| P4 跨画布/贴纸/笔记按需查询 | 满足（已实现范围） | `session-knowledge-service.ts:141–160` 同实例聚合 50 项分页、查询标题、删除/冲突/available；跨会话原生 ID 经当前 run 解析，未全量加载对象正文。 |
| P4 已发送引用、影响范围、有环图 | 满足（已测范围） | `session-knowledge-service.ts:161–185` 仅读 sent 引用、最大深度 8、总关系 200、visited 去环；fixed/new-content/source-unavailable 区分。cycle 与追加后 fixed 引用仍可读测试通过。固定 source-unavailable 的全部清理异常尚未重做故障注入。 |
| P4 由用户选择后重新讨论、不自动发送 | 满足（后端无自动运行）/UI 未验证 | Knowledge 服务只创建/读写关系；Host createSession 经正常 sessionController；源码没有后台模型调用或自动递归执行。最终用户交互交由画布/贴纸审计。 |

## 测试与复现文件

- `maintenance-focused-tests.log`：7 文件/33 项通过，包括 NativeSessionSpace、RC1 Broker 正常/两种崩溃、扩展数据、Engine 固定上游/分页预算、RC2 格式上游、知识网络与迁移正常流程。
- `maintenance-audit-repros.test.ts`、`maintenance-audit-vitest.config.mjs`、`maintenance-audit-repros.log`：额外 3 项复现测试全部通过。“通过”表示观测并断言了上述缺陷行为，不表示缺陷被修复。
- 复现 3 使用 RC1 编码器加实际 RC2 资源钩子验证公共 native-space 调用顺序，未假称它为官方 RC2 全量宿主测试。
- 本轮没有源码修复、部署或 Git 提交；真实副本仍应以当前运行审计和用户实际验收结论为准。


## 附录 B：引用与 Obsidian 子审计

# Annotation / Obsidian 引用与生命周期审计

日期：2026-09-14。只读源码与合成测试审计；没有修改项目源码、启动服务、访问真实会话/Vault 内容、打开浏览器或改动运行副本。

## 当前基线与证据范围

现场核对的工作区均干净；版本与 `artifacts/sticker-ui-dsh-20260914/copy-installation-final.json` 的 DSH 包版本一致。安装记录是上次安装证据，不等同于本轮实时运行确认。

| 项目 | HEAD | 版本 |
|---|---|---|
| Annotation Core | `49191157795ce74952e5bd8874472c1e606bc90f` | 0.3.12-rc2.6 |
| Sidechat | `3e8873e32e3ad77f68495dd0577340bb75e354df` | 0.4.7-rc2.6 |
| Obsidian Lifecycle | `7dc5c45223968c9758bed13a8f1f0677d8f2da89` | 0.3.3-rc2.10 |
| Obsidian Reference Adapter | `5195a563c2dd564da47ab48825e7a0f8cda80c3e` | 0.3.4-rc2.10 |
| Sticker Board | `3a63dd5a0b441843dfe991c707b0d017e0122d29` | 0.7.3-rc2.11 |
| Reference Suite | `be24478063ec2e7b105c35425bb221a8aaba54d7` | 0.3.4-rc2.11 |
| Obsidian Companion | `8c898561556e805b0fd1ab5526fa2a9b6c4ddf28` | 0.6.4-rc2.4 |

所有相对源码路径以下列目录为根：`D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913`。Companion 目录为 junction，实际指向 `worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge`。

对照需求：Maintenance `docs/superpowers/specs/2026-09-10-session-context-graph-requirements.md`、`2026-09-10-session-context-graph-plugin-changes.md`、`2026-09-14-session-stickers-knowledge-network.md`。最后一份已授权 P2/P4，不能再把它们整体当作未授权后续功能。

## 需要修正的问题

### R1 / P1：旧发送回执恢复会把用户修改后的新草稿误报为发送成功

- 触发：一次发送实际是否成功暂时无法确认，客户端记录 `uncertain`；用户修改文字或附件，再次发送；此时查询旧请求得到 `durable`。
- `dsh-annotation-core/src/client/composer-binding.tsx:332–346` 在新 `requestDigest` 与旧值不同的分支里，返回 `{ settled: { kind: 'success' } }`；`:283–290` 将其作为本次 `submitClaim` 成功返回，没有发送新输入。
- 已复现：审计目录 `references-repro.test.ts` 调用旧草稿（模拟响应丢失）后调用新草稿，第二次返回 success，但 `submitPlainClaim` 总调用仍为 1。期望“不把未发送的新草稿报告成功”的测试失败。日志：`references-repro.log`。
- 影响不是仅一条错误提示：原生 `deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts:858–884` 按此次 command 的 success 释放本次附件并提交本次输入状态。Core `src/client/native-adapter.tsx:38–43` 正是把 `submitClaim` 结果交给这个入口。新文字/附件可能被当成已发送而从输入框移除，却从未进入会话。违反 XR08/XR10。
- 应将“旧请求已确认”与“本次新输入已发送”分别表示；恢复旧结果不能消耗新草稿。当前审计只记录，不修代码。

### R2 / P2：初始引用材料没有按照本轮剩余容量计算额度

- `dsh-annotation-core/src/host/submit-annotated.ts:144–153` 仅获取模型 `contextWindow` 并传入 `prepareReferenceSet`；未纳入已有消息、系统/工具定义、本轮正文与附件、输出预留。
- `src/domain/budget.ts:4–5,35–38,95–100,126–127` 固定使用窗口的 20%，未知容量回退 65,536；`src/host/prepare-reference-set.ts:216–234` 据此决定默认问答轮次材料大小。初始读取有 16,000 字节单次上限和序列化预算，但这不能保证已接近满窗口的目标会话仍有同样剩余空间。
- 后续工具路径确实较严格：`src/host/upstream-budget.ts:10–24,33–68` 根据现有请求/工具和输出预留计算；Codex 使用实际内层 usage，不可估算媒体或未知 usage 拒绝扩展。该保护发生在后续工具调用时，不能反向保护已在提交阶段注入的初始材料。
- 这是 RD07 的初始阶段缺口，不是声称现有全部预算无效。最终是否被宿主压缩/拒绝依具体模型运行而定，本轮没有发真实模型请求。

### R3 / P2：已发送 Obsidian 引用的“回到来源”仍使用旧路径，笔记改名后不能按稳定身份解析

- `dsh-obsidian-reference-adapter/src/client/index.ts:57–61` 的 `openSource` 直接发送保存时的 `item.locator.notePath/blockId`。
- Companion `src/main.ts:1036–1038` 直接调用 `openNoteInMainMarkdownLeaf`；`src/workspace/open-note.ts:37` 将原路径交给叶子；`src/workspace/obsidian-adapter.ts:31–36` 只查该路径，文件不存在即报错。该链路没有 referenceId 或 noteId 查询，也没有块索引重定位。
- 对比：`src/vault/reference-source.ts:17–33` 的刷新路径已经能按块索引找到移动后的笔记，`src/vault/knowledge-store.ts:61–71` 的新知识链接也能按 noteId 解析。问题仅在旧/现有 Annotation 引用的打开来源入口，不能将新知识链接的改名支持等同于所有引用都已支持。
- 违反 OB03/OB04。静态链路确定，本轮未操作真实笔记改名；已有 `reference-source` 改名测试通过的是刷新能力，未覆盖此打开入口。

### R4 / P2：Obsidian 选段创建/挂接会话贴纸的入口未接通

- Companion `src/selection/editor-menu.ts:139–161` 和 `src/selection/reading-menu.ts` 末尾选区菜单只有“引用到 DSH”。
- 新知识入口 `src/main.ts:929–965` 以整篇 `notePath` 打开选择器；`src/ui/knowledge-picker.ts:39–47` 可以创建/解析真实会话；随后只写 `obsidian-links`，没有把选段/块作为来源，也没有创建 `stickers` 会话对象。
- 所以“整篇笔记关联真实会话”“新建真实会话并关联笔记”已实现；“从 Obsidian 选段创建会话贴纸、挂接已有会话贴纸”的 OB02/ST02 组合流程仍未完整实现。已与图谱审计交叉确认，主报告只需记录一次。

### R5 / P2：知识链接同步的批次和删除触发不完整，扩展面板可能长期保留过期状态

- Companion `src/main.ts:224` 删除事件仅更新本地知识登记的 missing 标记；`:228` 改名事件才调用 `syncKnowledgeLinks`。删除后不会立即将 missing 状态推送给 Maintenance，需用户运行修复命令或等其它同步触发。
- `src/main.ts:976–997` 每次从 `after = undefined` 开始，最多 20 页，每页 30 条；超过 600 条抛错，没有保存本批游标。再次运行仍从头开始，600 条之后的关系无法由该命令推进。与已持久化游标的 `importKnowledgeLinks`（`:1000–1016`）不同。
- 打开笔记时仍会通过 noteId 再校验，故不是打开错笔记的断言；问题在需求要求的当前位置/删除异常同步与可维护性。纯静态可确认，无真实大 Vault 压测。

## 已实现且有证据的语义

| 需求 | 审计结论 | 源码/测试证据 |
|---|---|---|
| 默认上下文包含来源问题及所选完整回答，工具过程按需 | 已实现；失败不静默降级为孤立选文。长内容明确 incomplete 与继续游标 | Core `src/host/upstream.ts:43–60`、`prepare-reference-set.ts:216–234`、`system-prompt.ts:11–14`；`tests/upstream.test.ts:91–129`、`submit-annotated.test.ts:170–204` 本轮通过 |
| 固定截至被选中的完成回复；后续来源轮次不渗入 | 已实现固定 sourceVersionId/cutoffEventId 与捕获版本校验 | Core `src/host/upstream.ts:26–40`；Maintenance `apps/engine/src/session-context-service.ts:43–87,106–143`；Core upstream 测试通过；Engine 更完整语义由 Maintenance 审计负责 |
| 后端按需读取/搜索，当前目标权限、撤销、单次与本轮共享额度 | 已实现后续读取主链；初始容量保留 R2 | Core `src/host/upstream-tools.ts:30–55`、`upstream-budget.ts:33–76`、`reference-tools.ts:47–71`；upstream 并发/拒绝草稿/撤销/Codex usage 测试通过 |
| 工作区→会话→完整页→输入框就绪后添加，幂等不自动发 | 已实现 | Sidechat `src/client/annotate/producer.ts:17–22`、`overlay.tsx:62`；Core `src/client/service.tsx:73–127`；graph-reference-actions 测试通过 |
| 只允许 Obsidian 内嵌窗口领取引用 | 客户端与 Companion 均有限制 | Adapter `src/client/index.ts:72–91`：无 surfaceId 不写 Core；Companion `src/bridge/server.ts:139–145,543–562`：按配置 referenceSurfaceId 过滤并拒绝其它领取；Adapter client-receiver 合成测试通过。Companion server 测试会监听端口，本轮未运行 |
| 持久化失败不确认领取；重试不产生重复引用 | 已实现核心流程 | Adapter `src/client/annotation-consumer.ts:43–75`：先 Core 持久保存，再 claim；永久冲突回收失败方对象；4项 consumer 测试通过 |
| 发送须等原生消息/上下文事件、接纳和 flush；失败恢复 | 已实现核心回执屏障及重启对账 | Core `src/host/session-reconcile.ts:161–168,254–297`、`submit-annotated.ts:348–369`；submit-annotated/session-reconcile 合成测试通过。异常网络响应+编辑草稿另有 R1 |
| 正常路径保留草稿文字、文件/图片顺序，拒绝后不偷发 | 正常和已覆盖失败路径通过；不能宣称所有重试边界通过 | Core `src/client/composer-binding.tsx:280–321`、`host/submit-annotated.ts:167–177`；composer-binding、admit-images 与 submit-annotated 测试通过；R1补测失败 |
| 笔记正文归 Vault，新知识关系归 Maintenance；单链接解除 | 已实现稳定 noteId 与标记范围编辑，显式删除冲突拒绝 | Companion `src/vault/knowledge-store.ts:113–155`、`knowledge-link-update.ts:4–9`；知识链接身份/删除保护/改名测试通过 |
| 旧写入冻结和激活不允许退回双写 | Companion有持久fence与串行写屏障，重复激活核对回执 | Companion `src/vault/knowledge-store.ts:43–47,84–99`；`main.ts:1042–1045`；knowledge-store测试通过。Maintenance迁移回执端由其审计负责 |
| Lifecycle停用/重连/响应超时不会继续挂载旧实例 | 合成生命周期测试通过 | `dsh-obsidian-bridge-lifecycle/src/request-scope.ts:7–35`；runtime/shutdown 11项测试本轮通过 |

新知识关系不自动注入笔记全文。已有 Obsidian 普通引用仍沿原先 snapshot/refresh 语义；不能把保留的既有文档快照误记为本轮新增全 Vault 备份。Sidechat 原生 fork 继续保持其独立旧语义，跨会话引用没有借用 fork 来复制上游。

## 本轮执行的测试

直接运行各仓库已安装的 Vitest，没有触发 pretest/build/install。测试只使用 fake 端口对象、内存/临时合成数据和 DOM 模拟；明确跳过会启动真实监听的 `reference-receiver.test.ts` / Bridge server 测试。

| 范围 | 结果 | 日志 |
|---|---|---|
| Core：upstream、submit-annotated、composer-binding、session-reconcile、graph-reference-actions、prepare-reference-set、admit-images | 7文件 / 54通过 | `references-core-tests.log` |
| Reference Adapter：client-receiver、annotation-consumer、reference-polling、obsidian-source-adapter | 4文件 / 17通过 | `references-adapter-tests.log` |
| Companion：knowledge-store、knowledge-link-update、reference-delete-state、reference-source、references、selection | 6文件 / 36通过 | `references-companion-tests.log` |
| Lifecycle：runtime、shutdown | 2文件 / 11通过 | `references-lifecycle-tests.log` |
| 新增审计复现：旧回执 durable 后发送修改草稿 | 1失败，确认 R1 | `references-repro.log` / `references-repro.test.ts` |

合计既有测试 118 通过，审计补测 1 项失败；通过项不能抵消补测所揭示的缺陷。

## 尚需真实副本验收的部分

- 当前安装包实际加载、四方 Host/Engine/浏览器/Companion 协议交互，本轮没有启动或调用服务，不能仅凭源码测试确认可用。
- Obsidian Electron/WebViewer 窗口恢复后 surfaceId 是否保持、当前目标页面实际气泡出现时间，以及独立窗口确实不领取，需要以真实窗口验收。
- 来源问答超过额度的实际模型行为、媒体附件对应模型可用空间、已接近上下文上限的长会话，需要处理 R2 后再验证。
- 真正的跨存储故障（Vault 写入成功但 Maintenance 回执丢失等）虽有持久意图/重试设计，当前验证仅覆盖合成状态机；不能宣称所有断电组合都已实测。

## 提供给总审计的 AC01–22 覆盖映射

“代码/合成通过”只表示本报告覆盖边界，不替代真实副本验收。

| 验收项 | 本审计可提供的结论 |
|---|---|
| AC01 | Core选择器有工作区→会话分页；真实滚轮/窗口行为未重验 |
| AC02 | Core使用Maintenance目录，不自行按200条截断；冷会话目录正确性由Maintenance审计确认 |
| AC03 | 加入引用不修改正文/附件、不自动发送，graph-reference-actions通过；发送重试后的新草稿另见R1 |
| AC04 | 目标输入框等待、导航变化检查、重复operationId逻辑及合成测试通过 |
| AC05–07 | Core固定版本/完成位置、拒绝不匹配与失败降级已覆盖；具体原生事件截断由Maintenance Adapter审计确认 |
| AC08 | 初始问答材料/不完整标记/游标通过；容量前置计算不完整见R2 |
| AC09–10 | Core后续单次与同轮共享预算、并发预留通过；Engine正文分页另由其审计确认；初始余量见R2 |
| AC11 | 工具只读当前目标已有引用，不自动展开嵌套引用；未做真实模型循环行为试验 |
| AC12 | 系统指令明确已读/未读且用户已授权自动读取；实际模型是否遵循必须真实会话验收 |
| AC13–14 | Obsidian新入口调用真实create-session/resolve，不直接跑自建模型；贴纸持久身份与Agent组合由图谱/运行审计确认 |
| AC15 | Companion链接使用单对象标记范围修改，knowledge-link-update拒绝误恢复；测试通过 |
| AC16 | 新noteId链接可解析移动；旧Annotation来源打开失败风险R3，选段会话贴纸入口R4；删除状态同步R5 |
| AC17 | Companion冻结/激活fence、不可退回旧写者通过；Maintenance迁移事务和整套双写验证由其审计负责 |
| AC18 | Annotation工具按Maintenance能力注入，不依赖ThoughtDAG；未执行真实插件停用 |
| AC19 | 此链路没有直接扫描DSH默认session目录；完整运行配置确认由Maintenance/部署审计负责 |
| AC20 | 跨会话初始上下文不另建全历史快照；旧Obsidian普通引用保留既有snapshot语义；整套内存/缓存容量未做压力验收 |
| AC21 | 固定版本inspect失败即停止准备，不切到最新版本；Core对应测试通过，Engine清理行为由其审计确认 |
| AC22 | 普通失败/回执未确认/幂等已有测试通过；新增R1表明断线后修改再提交仍有真实错误，不可判全通过 |


## 附录 C：图谱与贴纸子审计

# ThoughtDAG、会话贴纸与全局维护网络审计

审计日期：2026-09-14。范围：源码只读核查、合成数据隔离测试，以及协调任务提供的一项副本实测证据。本审计没有修改源码、部署包、用户会话或 Vault，没有操作运行副本，没有启动固定端口 18298/18299，没有调用真实模型。

## 结论

当前实现已经具有真实会话贴纸、Maintenance 管理的画布和对象、关系撤销与呈现删除的区分、冻结与回执驱动的迁移、有界影响查看和人工准备重新讨论的主要结构。**不能据此判定全部规格已满足。** 本轮 50 个隔离测试全部通过，同时确认了以下三个功能问题或缺口：

1. **F1 / P1：全局维护网络的会话项打不开。** 前端传逻辑会话 ID，宿主却读取原生会话 ID。协调任务已在正在使用的副本中复现；因此不是仅推测的契约问题。
2. **F2 / P2：保存到画布的固定材料，在来源追加正常新消息后不能再展开原问答。** 当前预览要求保存版本等于会话最新版本，即使旧版本仍存在，也会拒绝。失败是显式的，没有偷偷切换上下文，但缺少持久材料应有的固定版本浏览能力。
3. **F3 / P2：Obsidian 选区直接创建“会话贴纸”尚未连通。** 选区入口走普通引用流程；新增知识入口能从整篇笔记新建或挂接真实会话并保存知识链接，没有创建会话贴纸对象或保留该选区。不能把整篇笔记关联等同于 OB02 的选段创建贴纸。

另有一个 P4 范围差异：网络可以检索对象和对某个来源向下查看已发送引用影响，但没有将已发送引用作为独立可检索项统一列入默认网络目录。以下矩阵将其列为“部分”，不据此声称引用没有被保存。

真实模型调用、真实 Vault 对象迁移、重启后的完整组合恢复，以及用户数据上的双向笔记交互均未在本子任务验证。隔离测试通过只证明对应合成场景。

## 规格与源码基线

规格以当前文件内容为准：

- [原始设计与功能需求](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-session-context-graph-requirements.md)。
- [插件改动与实施顺序](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-10-session-context-graph-plugin-changes.md)。
- [09-14 会话贴纸、知识链接迁移与全局网络补充](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/docs/superpowers/specs/2026-09-14-session-stickers-knowledge-network.md:3)。该补充已明确授权 P2/P4，故不能继续把整个全局维护网络归为“后期计划”。跨运行实例自动启动、长期源版本永久保留、后台自动重跑不属于当前必须交付能力。

| 仓库 | 本轮读取提交 | 版本 |
| --- | --- | --- |
| ThoughtDAG | `3cb828583f99d8e0ec4c406dfdcb34b2fc515fee` | `0.4.14-rc2.4` |
| dsh-session-maintenance | `a68d0875fe3b6e85f08829d7a03c322a5f9fc1ae` | Engine `0.1.33-rc2.13`，Maintenance 插件 `0.2.26-rc2.9` |
| dsh-session-sticker-board | `3a63dd5a0b441843dfe991c707b0d017e0122d29` | `0.7.3-rc2.11` |
| obsidian-deepharness-bridge | `8c898561556e805b0fd1ab5526fa2a9b6c4ddf28` | `0.6.4-rc2.4` |

读取了适用 AGENTS；测试采用已有合成 fixture 与临时目录，未连接真实副本。这里的“通过”表示已阅读实现且没有发现此条的明确反例；附有隔离测试时会明确说明，不代表全链路用户验收已经完成。

## 具体发现

### F1：全局维护网络“打开会话”的跨 iframe 参数不一致

涉及 ST03、AC13，以及 09-14 补充的网络导航。

- [KnowledgeNetwork.tsx:25](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/KnowledgeNetwork.tsx:25) 先成功解析会话，随后调用 `parentRequest('open-session', { logicalSessionId: target.logicalSessionId })`。
- [宿主 client.js:98](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/client.js:98) 只读取 `input.nativeSessionId`，并拼成 `resolve?nativeSessionId=...`。该字段缺失，实际会查询 `undefined`。
- [正常画布入口 ManagedGraphApp.tsx:169](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:169) 正确传递 `nativeSessionId`，所以不能以普通画布节点能打开推定网络入口也能打开。
- [客户端请求封装 client.ts:56](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/client.ts:56) 使用通用输入，未在类型层按操作约束参数，现有宿主单测没有覆盖网络会话项实际传参。

副本实测由协调任务完成：点击网络中当前已经打开的 `DSH session session-793cbb1b…`，出现“会话未接入当前实例或已删除”。目标当时就在同一实例正常会话页中，排除了真正未接入。证据：[network-open-failure.png](D:/AI/DeepSeekHarness-Plugin/artifacts/system-audit-20260914/network-open-failure.png)。

建议修复边界：统一该操作的身份字段，并补实际网络点击到宿主解析的契约测试；不要通过宽松接受 `undefined` 或另建目标会话绕过。此次只报告，未修改。

### F2：来源追加后，固定材料展开被“必须最新版本”拦截

涉及 GR02，并影响固定来源材料的后续可读性。

- [ManagedGraphApp.tsx:223](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:223) 保存选区文本及 `sourceVersionId/sourceAnchorId`。
- [ManagedGraphApp.tsx:208](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:208) 展开该节点时继续传递这两个固定来源字段。
- [session-graph-service.ts:60](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-graph-service.ts:60) 读取当前 head；[同文件:67](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-graph-service.ts:67) 要求请求版本与该 head 相同，随后仅加载 head 事件。
- [现有测试:91](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/test/session-graph-service.test.ts:91) 明确断言追加后，旧游标和旧版本/锚点请求返回 409；同一测试随后从最新版本翻页仍能找到原回复。因此不是源内容已清理才不可用。

这是一项已被测试固定下来的保守行为。它避免了静默替换，却没有完成长期保存材料的固定版本展开。应区分“实时浏览游标已经过时”和“用户保存的固定历史材料”；对后者在源版本仍可用时读取该版本，不可用时再明确报错。这里没有把 Annotation Core 的固定引用读取链路判为失效，也没有要求新增全文备份或永久保留所有版本。

### F3：笔记选段创建会话贴纸仍只有相邻能力

涉及 OB02、P2；DSH 会话内选段创建贴纸已实现，缺口位于 Obsidian 选段入口。

- [editor-menu.ts:133](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/selection/editor-menu.ts:133) 的选区菜单是“引用到 DSH”；[main.ts:185](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/main.ts:185) 注册的编辑/阅读选区入口交给普通 `queueReference`。
- [main.ts:929](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/main.ts:929) 新命令和文件菜单以 `file.path` 打开知识选择器，没有选区参数。
- [knowledge-picker.ts:40](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/ui/knowledge-picker.ts:40) 支持创建/解析真实会话；[main.ts:956](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/main.ts:956) 后续只注册笔记、提交双链并写 `obsidian-links`，不写 `stickers` 会话对象。

现有功能可以“把当前笔记关联到新会话或已有会话”，但不能完成“从笔记所选段落创建会话贴纸并保留来源”。本轮未执行 Obsidian 真数据操作，结论来自上述完整入口与写入路径核查。

## 需求对应矩阵

以下证据链接定位实现入口；组合描述只合并行为一致的需求。09-14 文档没有独立需求编号，`P4-*`、`MIG-*` 是本报告使用的审计别名。

### 真实会话贴纸及关系归属

| 需求 | 状态 | 证据与边界 |
| --- | --- | --- |
| D01、ST01 | 通过 | [KnowledgePanel:60](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge-panel.tsx:60) 调用 create/resolve，再于第 72 行保存独立 `stickers` 对象；对象引用真实逻辑会话 ID。 |
| ST02 | 通过 | [选区入口 overlay:448](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/overlay.tsx:448) 与 [创建流程:60](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge-panel.tsx:60) 支持从 DSH 回复选区新建或挂接；两种选择分开。Obsidian 选段另见 F3。 |
| ST03 | 通过／入口例外 | [贴纸主体:110](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge-panel.tsx:110) 重新解析目标后调用 `ctx.sessions.open`，进入完整页。全局网络会话入口不满足，见 F1。 |
| ST04、AC14 | 未验证真实模型 | [官方创建接口:19](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/plugins/dsh-session-maintenance/src/session-knowledge.ts:19) 调用目标 DSH `sessionController.create`，随后正常打开。源码没有替代 Agent；本轮没有实际调用模型/工具，不能宣称整套工具权限已实测。 |
| ST05 | 通过（源码） | 同一创建路径只提交新会话身份，没有复制来源项目、模型或权限配置。 |
| ST06 | 通过（源码） | [KnowledgePanel:63](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge-panel.tsx:63) 经 Core 建立来源引用，保存来源版本、锚点、引用 ID；新会话仍有相同选区入口。真实多层讨论未运行。 |
| ST07、AC13 身份部分 | 通过（隔离） | [session-knowledge:19](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/plugins/dsh-session-maintenance/src/session-knowledge.ts:19) 使用操作 ID 确定性创建并先解析已有目标；[managed-graph:133](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/managed-graph.js:133) 有创建重试与冷会话解析。宿主测试覆盖幂等复用，不代表真实组合重启已验收。 |
| ST08、ST09、AC15 图/贴纸部分 | 通过（源码及隔离） | [图移除呈现 model:63](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/model.ts:63) 只修改图；[贴纸删除/恢复:110](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge-panel.tsx:110) 写对象修订；关闭面板不调用原生删除/归档。Knowledge 集成测试核查删对象后原生会话数不变。 |
| D07、D08 | 通过（本范围） | [Engine 写对象:61](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:61) 验证当前实例身份后写扩展域；画布保存选区与引用，迁移保存原有贴纸和映射，不新增整份会话或笔记快照。Core 实际上下文打包属于另一个审计范围。 |

### ThoughtDAG 展示与统一来源

| 需求 | 状态 | 证据与边界 |
| --- | --- | --- |
| GR01 | 通过（源码及隔离） | [model:1](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/model.ts:1) 定义会话、材料、贴纸、笔记四类节点及三类边；[ManagedGraphApp:257](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:257) 从扩展对象建立呈现。 |
| GR02 | 部分 | 折叠不加载全文，展开按页预览；固定材料在来源追加后被拒绝，见 F2。 |
| GR03 | 通过（本范围源码） | 贴纸面板直接调用 Core 并保存对象，无须打开画布；[model:68](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/model.ts:68) 后续从权威关系元数据导入已发送关系。Core 发送后关系提交的持久性由其它审计检查。 |
| GR04 | 通过 | [模型导入关系:68](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/model.ts:68) 以引用 ID 去重，多个来源各有关系；没有重写原生会话双亲。 |
| GR05 | 通过（图谱边界） | [connectKnowledge:105](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/model.ts:105) 的拖线只是知识关联；上下文动作经宿主/Core，未把图全体节点正文送给模型。工具预算及完整问答初始包留给 Core 审计。 |
| GR06 | 通过（调用边界） | [ManagedGraphApp:234](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:234) 的撤销调用域接口；[宿主:111](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/client.js:111) 解析引用后调用 Core 删除；第 355 行 UI 分开“移除连线”与撤销。撤销后模型工具是否拒读由 Core 审计。 |
| GR07 | 通过（源码及隔离） | [ManagedGraphApp:133](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/ManagedGraphApp.tsx:133) 从服务读取，153 行按修订 CAS 保存；[managed-graph:121](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/managed-graph.js:121) 经 Maintenance 扩展桥写入，浏览器只持未保存草稿。语义关系来自 Annotation 域，图中引用 ID 是呈现副本。 |
| GR08、AC19 | 通过（源码及隔离） | [managed-graph:63](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/managed-graph.js:63) 用已注册服务接口；[managed-entry:30](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/managed-entry.js:30) 对旧流式/注入路径返回停用响应。实际 managed 路径不自行扫描默认 `$DSH_HOME/sessions`。 |
| GR09、AC18 | 通过（结构），未验证真实启停 | 引用/贴纸调用 Core 和 Maintenance，图是可选消费者；移除 ThoughtDAG 不删除扩展对象。隔离测试覆盖缺少 Annotation 时通用知识关系仍可读，真实插件停用再恢复未执行。 |

### Obsidian 链接与迁移

| 需求 | 状态 | 证据与边界 |
| --- | --- | --- |
| OB01、OB03、AC16 | 部分／真实交互未验证 | [main:938](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/main.ts:938) 实现会话深链和 948 行笔记深链，支持稳定笔记/块定位；本次未用实际 Vault 验证所有标题/块、回复定位入口，不把源码支持等同于全部交互通过。 |
| OB02 | 部分 | 整篇笔记新建/挂接与会话跳转存在，所选段落生成会话贴纸缺失，见 F3。 |
| OB04 | 通过（隔离） | [knowledge-store:58](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/vault/knowledge-store.ts:58) 以稳定笔记 ID 和索引解析，歧义报错；合成测试包含改名和定位，不借路径误认另一篇笔记。 |
| OB05 | 通过（源码） | [main:956](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/main.ts:956) 仅写链接对象和关联标记，没有模型自动提交或全篇注入。 |
| OB06、AC15 笔记部分 | 通过（隔离） | [knowledge-store:123](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/vault/knowledge-store.ts:123) 先持久化链接意图再改所选标记范围；链接更新测试验证单处删除与保留正文。 |
| MIG-01 冻结、摘要、冲突、幂等导入 | 通过（隔离） | [Sticker knowledge:30](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/client/knowledge.ts:30) 冻结两端→显式合并冲突→摘要→stage→activate；[Engine:77](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:77) 校验迁移 ID/摘要和映射后激活。重试不产生第二批对象。 |
| MIG-02 重启/失去回执不能双写、AC17 | 通过（隔离） | [本地 ownership:63](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/host/local-store.ts:63) 持久冻结标记；[Vault:87](D:/AI/DeepSeekHarness-Plugin/worktrees/rc2-adapt-20260912/obsidian-deepharness-bridge/src/vault/knowledge-store.ts:87) 冻结与激活核对；[remote service:22](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-sticker-board/src/remote/service.ts:22) 已迁移且服务不可用时拒绝回旧真源。 |
| MIG-03 正文/旧块保留、无全文快照 | 通过（源码及隔离） | 迁移读取旧贴纸结构，将对象写入扩展域；激活仅保存 ownership/回执，不搬走或删除 Vault 正文。合成测试验证已托管编辑不再读写旧 Vault 贴纸正文。 |
| MIG-04 真实旧数据迁移验收 | 未验证 | 现有界面提供逐会话迁移和继续迁移，未自动迁移全部 Vault。本审计没有点击迁移、冻结真实对象或核对真实旧块全量数据；不得称用户存量已完成迁移。 |

### 全局维护网络及影响分析

| 需求 | 状态 | 证据与边界 |
| --- | --- | --- |
| P4-01 当前实例跨画布对象检索、分页、隔离 | 通过（隔离） | [session-knowledge-service:141](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:141) 按当前 run、实例/profile 查询元数据，返回 50 项加游标；测试覆盖超过一页、隐藏会话和跨实例拒绝。 |
| P4-02 所有已发送引用、来源/去向与状态统一浏览 | 部分 | 同一目录仅列会话/画布/贴纸/笔记，不列 `annotation-upstream` 引用对象；[impact:161](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:161) 另行按来源做出向引用遍历；[KnowledgeNetwork:31](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/KnowledgeNetwork.tsx:31) 仅在选择影响查询后加入该子图。缺少独立引用搜索和完整入向关系浏览入口，不等于没有关系真源。 |
| P4-03 删除、冲突状态与可用性 | 通过（源码） | [KnowledgeNetwork:50](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/KnowledgeNetwork.tsx:50) 显示状态与冲突数；[Maintenance 网络页:20](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/dashboard/src/knowledge-network.tsx:20) 明确转对应扩展数据面板处理恢复/删除/冲突，不把列表状态当自动解决。 |
| P4-04 会话导航 | 不满足 | 网络会话项参数错误，真实副本已复现，见 F1。普通图节点/贴纸主体是不同调用路径。 |
| P4-05 有界影响、环终止、固定有效与来源不可用区分 | 通过（隔离） | [impact:161](D:/AI/DeepSeekHarness-Plugin/worktrees/session-context-graph-20260913/dsh-session-maintenance/apps/engine/src/session-knowledge-service.ts:161) 访问集+BFS，默认深度 4、合同上限 8，结果数量有界；按固定版本存在性与 head 变化分别标记。追加消息不会直接撤销固定引用。此处与 F2 的画布预览校验是两条路径。 |
| P4-06 用户选择后准备重新回答、不后台自动运行 | 通过（源码），真实模型未验证 | [KnowledgeNetwork:35](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/src/maintenance/KnowledgeNetwork.tsx:35) 处理用户选择并用操作 ID 准备下一项；[宿主 client:88](D:/AI/DeepSeekHarness-Plugin/repositories/thoughtdag/dsh/lib/client.js:88) 解析目标，预览最新来源，调用 Core 增加引用和评论，返回对话页，没有提交模型请求。用户发送后的真实回答不在本轮验证范围。 |
| P4-07 自动监控与无限递归重放 | 非本期必需 | 目前影响是用户按需查询；后台自动运行被规格排除。没有自动重跑不应记为故障。 |

## 本轮隔离测试

以下均于本轮执行，全部进程退出码为 0。直接使用已有 Node 与仓库测试运行器，未安装依赖、未构建部署包。Engine HTTP 测试使用随机临时端口，服务默认 `listen(input.port ?? 0)`，没有使用 18298/18299。

| 仓库与命令 | 结果 | 主要覆盖 |
| --- | --- | --- |
| ThoughtDAG：`node --test dsh/tests/managed-host.test.mjs src/maintenance/model.test.mjs src/maintenance/client.test.mjs` | **36 tests passed** | 宿主桥接与能力边界、创建重试/身份、图模型与删除/关系来源、客户端消息校验和分页请求。未覆盖 F1 的实际网络入口传参。 |
| Maintenance：`node node_modules/vitest/vitest.mjs run apps/engine/test/session-knowledge.test.ts apps/engine/test/session-graph-service.test.ts apps/engine/test/managed-graph-schema.test.ts --maxWorkers=1` | **4 tests passed / 3 files** | 大型合成集成测试覆盖稳定会话对象、迁移/CAS/分页/隔离、有环影响、预览分页、模式校验。F2 的保守拒绝当前被测试明确断言。 |
| Sticker：`node node_modules/vitest/vitest.mjs run tests/knowledge-migration.test.ts --maxWorkers=1` | **4 tests passed** | 持久冻结、冲突/待删除对象、激活回执丢失重试、托管后不回写旧 Vault。 |
| Companion：`node node_modules/vitest/vitest.mjs run tests/knowledge-store.test.ts tests/knowledge-link-update.test.ts --maxWorkers=1` | **6 tests passed** | 合成笔记身份、冻结/激活和单处链接更新。 |
| 合计 | **50 tests passed** | 不等于 50 条产品验收，也不等于已验证真实模型、真实 Vault 或全部浏览器入口。 |

## 留待根任务整合的验收边界

- F1 已有源码与副本两类证据，先修复并复测实际网络会话项。
- F2 应讨论并实现固定材料预览与实时游标的区别，不新增逐轮全文备份。
- F3 是已授权 P2 的功能缺口；需要选区入口、来源数据及会话贴纸对象的一条完整写入链。
- 真实模型/工具环境、Core 的引用工具预算和初始问答包、durable Maintenance 回执，由负责相应链路的审计报告汇总。
- 真实 Vault 迁移与真实组合重启未验证；当前保护措施及合成恢复测试不能替代用户存量数据验收。

本报告只记录审计结论，没有执行修复或部署。
