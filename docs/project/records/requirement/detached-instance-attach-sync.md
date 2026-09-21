---
id: REQ-detached-instance-attach-sync
kind: requirement
title: 实例先启动、引擎后接管与覆盖式真源同步
status: current
summary: 引擎启动后检出并连接已在运行的实例；连接与 Launcher 解耦，改为选择 DSH Home 根目录；覆盖式同步只作用于显式勾选的同步工作区，覆盖写入实例活动会话目录并刷新 WebUI 可见；同步范围「未显式选择即为空」；非维护工作区的会话不进真源，但在 DSH 里照常读写与对话。
progress: in_progress
gap: 部分实现（目录式连接地基、握手/租约与单次接管、覆盖式写入器、自有存储映射、实例侧工作区级右键入口、写访问门重定义，以及第 12 条）；但这些改动只在本地分支、未推送、未构建进发行包，**无任何一项通过实际实例验收**。仍未落地：引擎启动时询问是否同步的弹窗、目录选择器接入引擎连接路径、可选的第 11 条实例侧范围入口；第 7 条「已打开会话是否被宿主内存缓存」也尚未实测。
relations:
- relation: supersedes
  to:
    record_id: REQ-runtime-workspace-creation
  reason: 实例自带工作区不再自动登记进真源，改为用户在右键菜单显式加入
---

# 实例先启动、引擎后接管与覆盖式真源同步

来源：2026-09-21 用户在当前 DSH 会话的正文要求，并由同一消息的注释确认「sessionmaintenance 不阻碍实例的启停行为」；同一轮后续**用户注释**逐条回答了下方的边界问题，并纠正了「接管依赖 Launcher」的说法。本记录中标注「用户注释」的结论来自 2026-09-21 用户在 DSH 会话中的注释，不是模型推断。第 12、13 条与「(a) 保持现状 / (b) 已实现」的处置，同样来自 2026-09-21 用户在 DSH 会话中的要求（该会话的后续轮次），不是模型推断。此要求替代此前「已注册实例必须经正式生命周期入口启动、否则插件拒绝加载」的启动门语义。连接方式与同步权威的正式决定另见 [[DEC-directory-connect-sync-authority]]。

## 用户要求

- 允许**先启动实例、再启动引擎**。不是在 Launcher 启动时因为检测到引擎没启动就由 hook 阻止正常启动。
- 引擎启动后**自动检出已经启动的实例并连接**，连接后自动执行真源同步程序。
- 通过实例侧 Session Maintenance 插件弹出确认，由用户决定是否执行同步。
- 同步语义（引擎启动前）：在引擎启动前，DSH 实例侧在**已勾选同步工作区**内的改动不被承认，直接被引擎真源覆盖——包括新增会话、归档会话，以及已有会话中产生的新会话。
- 连接成功后恢复既有逻辑：DSH 在当前工作区的改动和新产生的会话直接同步到引擎真源。

## 本轮用户注释确认的结论

### 1. 插件侧握手/租约（用户注释：同意，无修改）

引擎缺席时，插件侧留下**可供引擎发现的握手/租约**。引擎启动后据此检出已运行实例并连接，不要求实例重启，也不要求实例在启动时就知道引擎是否可达。

### 2. 引擎侧接管不得依赖 Launcher（用户注释：纠正）

引擎侧接管**不得依赖 Launcher**，否则形成对 Launcher 的依赖耦合；应**像 Vault 绑定一样，通过「选择实例文件夹」的方式连接**。核对现有实现后的待替换项与可保留为兼容的路径见 [[DEC-directory-connect-sync-authority]]。

### 3. 同步权威与工作区登记（用户注释：删除旧规则，改用新规则）

- 引擎真源中来自 DSH 侧的改动，**只**依赖**已绑定**的 DSH 实例在**同步工作区内**产生的会话改动。非绑定实例、非同步工作区产生的 DSH 改动不进入真源。
- 同步工作区**默认全部不勾选**。
- 实例自带的工作区**不自动**登记为 Maintenance 维护的真源工作区，而是作为**该实例的自有工作区**存在。
- 在**原本的右键操作菜单**里提供「将当前工作区加入 sessionmaintenance」选项；在 Maintenance 引擎启动时，把选中的工作区加入 Maintenance 的维护工作区。
- Maintenance 有自己的会话原件（真源存储），靠 adapter 与实例交换改动；被加入的工作区应当在 **Maintenance 自己维护的会话存储区域中新增一个文件夹**，并把 DSH 会话**映射成它自己的存储形式**。
- 明确替代：此前的「原生新会话登记进真源（`importDshNative`）」与「未完成恢复则拒绝覆盖原生目录」两条规则**不再适用**。

### 4. 非同步工作区（用户注释）

没有被 Maintenance 维护的工作区，作为 DSH 当前实例的自有工作区，**里面的会话不受影响**——不被覆盖，也不进入真源。

### 5. 归档对齐（用户注释：确认「是的」）

真源未归档、本地却归档了，覆盖时**恢复为未归档**（对称覆盖）。归档状态与正文一样按真源为准双向对齐。

### 6. 实施顺序（用户注释）

先做**引擎侧「检出 + 接管 + 覆盖同步」**；理由是它不需要重启实例、不挂 hook 就能验收。**「取消实例侧启动门」放到后面做**：用户担心先挂 hook 会导致实例起不来、没法工作。

### 7. 接管后「覆盖」怎样可见（2026-09-21 用户在 DSH 会话中的修正）

用户指出，框架里的「引擎只做真源覆盖、实例原生文件不重写」是错的：「刷新一下 WebUI 页面就可以改了」——刷新即生效，**不需要重启实例**。他的经验来自以前让别的会话把其它实例的会话复制进来，也是这样生效的。按此修正：

- 覆盖写到**实例当前实际使用的会话目录**。本机真实布局（用户本次给的路径比实际少一层）：`<DSH_HOME>\sessions\<工作区目录>\<会话目录>\session.v3.jsonl.zstd`，例如 `...\homes\0.1.5-rc.2 测试\sessions\--D-DeepSeekDemoWorkplace--\<会话 UUID>\session.v3.jsonl.zstd`；该实例为每会话一个目录的普通文件存储，未使用引擎 native space。
- 已核实（本机只读）：DSH 的 JSONL 持久化按需列目录，没有启动期索引——`@deepseek-ai/dsh-session-persistence-jsonl` 的 `listProjectDirs` / `listSessionDirs` 都是 `readdir`，所以刷新会重新扫盘。用户「刷新即可见」的经验因此有据可循。
- **尚未实测**：已经打开的会话是否被宿主缓存在内存里（是否只在下次打开时才重读磁盘）。建议用一个**未打开**的会话验证，仍不重启实例。
- 与用户经验的差别：他以前是**把整个会话目录复制进来**，而本要求是就地覆盖一个该实例正在使用、且可能正被引擎读取的会话；目录扫描这一环已核实，「就地覆盖后是否对已打开会话即时生效」仍待验证。
- 据此，需求口径是：**引擎按 adapter 的原生格式写回实例的活动会话目录**。adapter 侧已有可写原生 v3 格式的编解码（`packages/adapter-dsh-0-1-5/src/native-session-codec.ts` 的 `encode` / `verifyEncoded`），所以这条不是「必须新增写能力」，而是接管路径要改用该能力写回实例目录。

### 8. 同步范围默认（2026-09-21 用户在 DSH 会话中的修正）

用户否掉了「存量保持 all」。**不存在「历史默认范围／legacy all」这种概念**：「没有显式选择」一律就是**空**，新接入与存量一视同仁。某实例同步哪些工作区，就等于它在 Maintenance 面板里**显式选择**的那批；增减都在面板里改。

**必须如实记录的后果**：原先依赖「无记录 = all」的已接入实例，升级后范围会变成空，直到用户在面板里重新勾选。受影响的存量实例清单由另一个任务只读核查，本记录只登记这一规则与后果，不含实例清单。

### 9. 选择实例文件夹的那一层（2026-09-21 用户在 DSH 会话中的确认）

用户确认选 **DSH Home 根目录**（其中包含 `profiles/` 与 `sessions/`），因为 profile 层无法区分同一 Home 下的多个 profile；并且**要在选择栏旁边给出文字提示**，建议文案：

> 选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别

### 10. 同一实例出现两张卡（2026-09-21 用户在 DSH 会话中的确认）

确认按 `(instanceId, profileId)` **合并为一张卡**，并在卡上**标注连接来源**（Launcher / 目录式），不再按连接来源各出一张卡。

### 11. 可选：DSH 侧的同步范围入口（2026-09-21 用户在 DSH 会话中的提议，标为可选）

用户提到「连接上之后可以让 DSH 侧也提供修改同步范围的选项」。本条记为**可选需求，不是本轮必须实现**；它若实现，需要**新增实例侧界面入口**，与现有的维护看板面板并存。

### 12. 非维护工作区的会话不进库，但在 DSH 里必须能正常对话（2026-09-21 用户在 DSH 会话中的要求）

来源：2026-09-21 用户在 DSH 会话中的要求（同一轮的补充表述）。

- **要求本体**：不属于某个已加入同步范围的工作区里的会话，**不进维护库**；但该会话在 DSH 里**必须照常读写、照常对话**——不能弹错、不能卡住。
- 「不进库」的实现位置：引擎在运行期登记该会话时拒绝，抛出 `SESSION_NOT_SYNCED`，见 `apps/engine/src/runtime-workspace-registration.ts:65`（项目解析不出已加入的工作区）与 `:76`（工作区不在该 run 冻结范围内），以及 `apps/engine/src/instance-workspace-runtime.ts:47`（提交写入时的同一判定）。拒绝时**不登记任何东西**（无 `logical_sessions` / `logical_workspaces` / `runtime_workspace_bindings` 行）。
- 「照常对话」的实现位置：这条拒绝只发生在**登记/提交**这一步，不经过宿主的写入路径。写入侧的门是 `plugins/dsh-session-maintenance/src/write-access-scope.ts` 的 `ScopedSessionWriteAccess`：范围外目标一律 `open`，`assertWritable` 立即放行且**不查引擎**（即写访问门的重定义，见下方「与当前实现的关系」）。登记失败在插件侧被收敛为**该会话的失败记录**（`projection-runtime.ts` 的 `failures.set`，由 `flush` 抛出），而 DSH 会话自身的读写不依赖引擎。
- **触发时机（只读核查结论）**：登记不是每次对话都发生。`registerProjectionRuntimeSession` 唯一的运行期入口是引擎的 `POST /v1/runtime-broker/runs/:runId/sessions`（`apps/engine/src/http/routes.ts:350`），而插件只在**显式的 `create-session` 知识操作**里调它（`plugins/dsh-session-maintenance/src/session-knowledge.ts:37` → `MaintenanceGraph.created` → `index.ts:177` 的 `retainExplicitSession`）。因此普通会话对话根本不经过这条路径。
- **用户可见性**：引擎把该错误转成 `409 {"error":{"code":"SESSION_NOT_SYNCED"}}`（`apps/engine/src/http/routes.ts:792-793`），只有调用方才看得到；它属于「本插件自己的一个操作失败」，不是「宿主会话坏了」。**未发现它会冒到用户面前或阻塞宿主会话读写**，因此无需按第 3 条停下。
- **测试**：`plugins/dsh-session-maintenance/test/out-of-scope-conversation.test.ts`（范围外写入放行、引擎不可达也不拦、范围外不受范围内故障影响、未接管时一概不拦）；拒绝那一半由 `apps/engine/test/runtime-new-workspace.test.ts` 断言（`SESSION_NOT_SYNCED` 且零登记）。

### 13. 工作区加入时的历史会话范围（2026-09-21 用户在 DSH 会话中的要求）

来源：2026-09-21 用户在 DSH 会话中的要求（上一轮留下的待确认边界之一）。用户确认：工作区被加入同步范围时，该工作区中**已存在**的会话**一次性全部映射**进 Maintenance 自有存储，此后新产生的会话**增量**进入。即「加入」不是从加入时刻起划一条线，而是先补做一次全量映射，再转为增量。

**实现状态（源码已落地，未验收）**：`apps/engine/src/workspace-session-mapping.ts` 的 `mapJoinedWorkspace` 已按此实现——文件头注释写明「Joining is a one-off act by an operator, so it maps every session the workspace already has; everything after that arrives through the ordinary incremental path」，并且不重复映射已知道的会话；它经 `apps/engine/src/composition-root.ts:426-443` 的 `mapWorkspace` 端口接到实例侧的「加入工作区」入口（目录由引擎从实例 Home 与工作区路径推导，不采信调用方给的位置）。测试 `apps/engine/test/workspace-session-mapping.test.ts`。改动只在本地分支，未推送、未构建、未做真实实例验收。

## 与当前实现的关系（已落地部分 / 仍未落地部分；一律不得写成已验收）

**已落地的部分**（本地提交，未推送、未构建、未做实例验收）：第 3、4 条的默认范围与「实例自带工作区不自动登记」；删除实例工作区时的自动登记；插件侧握手/租约与引擎侧单次接管（含 (b)）；覆盖式**写回能力**（模块已实现、尚未接进运行路径）；Maintenance 自有存储映射与第 13 条的一次性全量映射（已接到实例侧加入入口）；实例侧工作区级右键入口；写访问门重定义。

- **写访问门重定义（已落地）**：`plugins/dsh-session-maintenance/src/write-access-scope.ts` 提供 `openWriteScope`（默认，放行一切）、`FrozenWriteScope`（接管成功后冻结一次范围快照）、`ScopedSessionWriteAccess.assertWritable`（范围外或未知身份**直接放行、不查引擎**；范围内才委托给已注册实例的写访问检查）。接线在 `plugins/dsh-session-maintenance/src/index.ts`：门始终提供，`runtime.attach()` 成功后替换为 `FrozenWriteScope`（范围取自 `launchProfile.scopeWorkspaceIds` / `scopeIncludeUnassigned`），`agent/pre-step` 传 `writeTargetOf(payload)`。证据：`plugins/dsh-session-maintenance/test/write-access-scope.test.ts`、`test/out-of-scope-conversation.test.ts`。

- **实例侧启动门（仍未落地的那一半，用户已明确暂缓）**：当前实现与该要求相反——`plugins/dsh-session-maintenance/src/registered-startup.ts` 的 `assertRegisteredStartup` 在 `sessionSource === 'maintenance'` 或实例/profile 出现在 `maintenance-required.json` 时，于实例侧直接抛错「此实例已接入 Maintenance，请先启动并确认维护服务就绪，再通过正式生命周期入口启动。」；配合 Launcher 外部生命周期 hook 的 `prepare` 阶段构成启动门。`maintenance-required.json` 由引擎接入流程写入（`apps/engine/src/integrations/service.ts` 的 `setMaintenanceRequired(..., true)`），两者是同一耦合的两端。取消这道门是本要求的后半项，见第 6 条，本轮**未动** `registered-startup.ts`。
- 引擎侧**已有**基于插件握手/租约的接管路径（已落地）：插件在引擎缺席时留下租约，引擎 `apps/engine/src/instance-lease.ts` 的 `inspectInstanceLease` 按**操作系统进程证据**判定 `running` / `not-running` / `stale`（该文件 `:22` 注释说明「a takeover can find it without a scan」，即不靠扫盘发现），`challengeInstanceLiveness` 要求实例自己确认（`POST /dsh-session-maintenance/instance/lease`），随后 `apps/engine/src/integrations/service.ts` 的 `takeoverInstance` 经 `prepareTakeover` 准备 run；路由为 `POST /v1/integrations/takeover`、`POST /v1/integrations/takeover/:ticketId/claim`、`GET /v1/integrations/takeovers`（`apps/engine/src/http/integration-routes.ts`）。底层仍是本进程 `prepareRun` 产生的 run，因此 `ProjectionLifecycle.attachRun` 的 `RUN_NOT_PREPARED`（`packages/projection-lifecycle/src/lifecycle.ts`）**未被放宽**，Launcher hook 与 `standalone-runtime` 路径也仍在。**未落地的那一半**：引擎**启动时自动**触发检出与连接（自动那一半）——只读检索 `apps/engine/src` 内的 `takeover` / `lease` 未见启动期自动接管入口，当前入口是调用方发起 + 实例侧确认。
- 实例连接**已具备「选择文件夹」式的第一段**（已落地）：`apps/engine/src/instance-folder.ts` 的 `createWindowsInstanceFolderPicker` / `selectInstanceFolder` / `inspectInstanceFolder` 校验所选目录确实含 `profiles/`、官方启动程序与已声明配置（失败码 `INSTANCE_FOLDER_INVALID`），已接到 `apps/engine/src/integrations/service.ts:81` 的接入流程，Dashboard 接入页显示提示文案 `INSTANCE_FOLDER_HINT`（`packages/contracts/src/host-integration.ts:85`，与第 9 条要求的文案一致）。`InstanceHomeInspection`（同文件 `:96-106`）**只凭所选文件夹**给出 `suggestedInstanceId`、`profiles[]`（`profileId` / `root` / `web`）、`runtimeVersion`、`versionRoot`、`cliPath`。**未落地的那一半**：把每个 profile 落成实例卡、以及同一实例多来源时按 `(instanceId, profileId)` 合卡并标注连接来源（第 10 条；绑定侧已加 `connectionKind` 字段，存量缺省 legacy）。
- 「覆盖式同步」与旧规格冲突的点已按第 7 条改写：现规格中原生侧新会话会被登记进真源（`importDshNative`）、且「存在未解决恢复时拒绝覆盖原生目录」（`docs/superpowers/specs/2026-09-10-persistent-native-session-space.md`）。这两条已被本轮用户注释删除，旧规格原文已标注「2026-09-21 被替代（原文保留）」（该规格 `:32`、`:39`、`N09 :83`）；**替代实现已部分落地**：单次接管（不再因「存在未解决恢复」拒绝）已实现，覆盖式写入器已实现但**尚未接进运行路径**（见下一条）。
- 第 3 条的 (a)「原生新会话自动登记进真源」与 (b)「未完成恢复则拒绝覆盖原生目录」两条旧规则的处理**已由用户拍板并实施**：
  - **(a) 保持现状，不改代码**。理由：第 3 条与第 4 条的落地（同步范围默认空、实例自带工作区不自动登记进真源）生效后，非维护工作区的新会话在**登记阶段**就被 `SESSION_NOT_SYNCED` 拒绝（见第 12 条），「原生新会话自动进真源」的语义已不成立，无需再改。用户 2026-09-21 确认「(a) 不动」。
  - **(b) 已实现并提交**：移除了「未完成恢复即拒绝接管」这一条件（`packages/projection-lifecycle/src/native-space.ts` 的 `ownerIsFinished()` 及其调用点），改为允许多次接管同一原生目录；**保留**其余全部保护：另一 run 的事务拒绝、`verifyInventory` 身份校验、路径冲突、「checkpoint 后被改写」拒绝、未归属文件拒绝、暂存字节校验、`lifecycle.ts` 的 `RUN_NOT_PREPARED` 与 `discardPreparedRun` 不变。证据：`packages/projection-lifecycle/test/native-space.test.ts` 的 N09/N10 已改写并加强（接管成功解析、旧字节仍可读、旧 run 仍未解决，同时「changed after checkpoint」与「not safely closed」仍被拒绝）。
- 实例侧工作区级右键入口**已落地**：`plugins/dsh-session-maintenance/src/client/workspace-menu.ts`，菜单项 id `workspace-join`、文案「将当前工作区加入 sessionmaintenance」，挂在工作区菜单（非会话菜单 `SESSION_MENU_ITEMS`）上；但「引擎启动时询问是否执行同步」的弹窗流程仍不存在。
- 覆盖式写回的能力**已实现但尚未接线**：`apps/engine/src/instance-session-writeback.ts`（`writeBackProjectionToInstance` / `materializeNativeSessions`）依赖 `native-session-overwrite.ts`，把真源投影按 adapter 的原生 v3 格式写回实例的 `sessions/<项目目录>/<会话目录>/session.v3.jsonl.zstd`；仓库内除它自己的测试 `apps/engine/test/instance-session-writeback.test.ts` 之外**没有调用方**，`composition-root.ts:427` 目前只用到 `nativeProjectDirectory`。因此引擎的连接/接管路径**仍不写**实例会话目录，也仍不选目录接入。

## 待用户确认的边界

- 验收用哪个实例与哪些工作区。
- 引擎先于实例启动、以及引擎在中途重启这两种时序是否同样适用。
- 第 3 条的「只依赖同步工作区」是否同样收窄 Codex 侧的只读增量导入（Codex 是另一真源）；本轮注释未说明。
- 第 8 条落地时，原先依赖「无记录 = all」的存量实例范围清零后，是否需要升级提示或一次性确认（清单由另一任务只读核查，本记录不查数据）。
- 可选的第 11 条是否需要在本轮之后单独立项（实例侧界面入口的归属与验收方式未定）。

（本轮已由用户答复的边界：覆盖的可见方式见第 7 条；同步范围默认见第 8 条；文件夹层级见第 9 条；同实例两张卡见第 10 条；工作区加入时是否映射**已存在**的会话见第 13 条——一次性全量映射，之后增量。）

## 验收（待实现后填写实测）

实例在引擎未启动时可正常启动并使用；引擎启动后自动检出并连接成功；确认后按勾选工作区执行覆盖同步，未勾选工作区内容不变；覆盖写入实例活动会话目录后**刷新 WebUI 即可见、且不重启实例**；连接后 DSH 的改动与新会话进入真源；异常退出与恢复仍保留既有证据链。当前无任何一项通过实际实例验收；第 7 条里「已打开会话是否被宿主内存缓存」也尚未实测。
