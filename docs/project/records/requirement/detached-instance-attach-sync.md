---
id: REQ-detached-instance-attach-sync
kind: requirement
title: 实例先启动、引擎后接管与覆盖式真源同步
status: current
summary: 引擎启动后检出并连接已在运行的实例；连接与 Launcher 解耦，改为选择 DSH Home 根目录；覆盖式同步只作用于显式勾选的同步工作区，覆盖写入实例活动会话目录并刷新 WebUI 可见；同步范围「未显式选择即为空」。
progress: planned
gap: 全部要求尚未实现，也无实际实例验收；第 7 条「已打开会话是否被宿主内存缓存」尚未实测。
relations:
- relation: supersedes
  to:
    record_id: REQ-runtime-workspace-creation
  reason: 实例自带工作区不再自动登记进真源，改为用户在右键菜单显式加入
---

# 实例先启动、引擎后接管与覆盖式真源同步

来源：2026-09-21 用户在当前 DSH 会话的正文要求，并由同一消息的注释确认「sessionmaintenance 不阻碍实例的启停行为」；同一轮后续**用户注释**逐条回答了下方的边界问题，并纠正了「接管依赖 Launcher」的说法。本记录中标注「用户注释」的结论来自 2026-09-21 用户在 DSH 会话中的注释，不是模型推断。此要求替代此前「已注册实例必须经正式生命周期入口启动、否则插件拒绝加载」的启动门语义。连接方式与同步权威的正式决定另见 [[DEC-directory-connect-sync-authority]]。

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

## 与当前实现的关系（不得写成已实现）

- 当前实现与该要求相反：`plugins/dsh-session-maintenance/src/registered-startup.ts` 的 `assertRegisteredStartup` 在 `sessionSource === 'maintenance'` 或实例/profile 出现在 `maintenance-required.json` 时，于实例侧直接抛错「此实例已接入 Maintenance，请先启动并确认维护服务就绪，再通过正式生命周期入口启动。」；配合 Launcher 外部生命周期 hook 的 `prepare` 阶段构成启动门。`maintenance-required.json` 由引擎接入流程写入（`apps/engine/src/integrations/service.ts` 的 `setMaintenanceRequired(..., true)`），两者是同一耦合的两端。
- 引擎侧目前没有「扫描已运行的 DSH 实例并 attach」的路径：`ProjectionLifecycle.attachRun` 只接受本进程 `prepareRun` 产生过的 run，否则报 `RUN_NOT_PREPARED`（`packages/projection-lifecycle/src/lifecycle.ts`）；现有入口是 Launcher hook 的 prepare/beforeStop/afterExit，或引擎 `standalone-runtime` 自行拉起 DSH。
- 实例连接目前不是「选择文件夹」式：Vault 侧已有目录选择形态（`apps/engine/src/vault-folder.ts` 的 `createWindowsVaultFolderPicker`、`inspectVaultFolder`，被 `apps/engine/src/vault-bindings.ts` 调用）；实例侧要求调用方直接给出 `StandaloneInstance`（instanceId/profileId/name/runtimeVersion/homeRoot/versionRoot/runtimeUrl，`packages/contracts/src/standalone-instance.ts`），没有从所选文件夹推导身份与 profile 的机制。
- 「覆盖式同步」与现有语义冲突：现规格中原生侧新会话会被登记进真源（`importDshNative`），且「存在未解决恢复时拒绝覆盖原生目录」（`docs/superpowers/specs/2026-09-10-persistent-native-session-space.md`）。这两条已被本轮用户注释删除，但替代实现尚不存在。
- 实例侧目前没有「引擎启动时询问是否执行同步」的弹窗流程，也没有工作区级的右键入口（现有 `SESSION_MENU_ITEMS` 是会话级菜单项）。
- 接管写回实例目录的能力未见使用：adapter 已有原生 v3 编解码可写（`packages/adapter-dsh-0-1-5/src/native-session-codec.ts`），但引擎侧连接/接管路径目前不写实例会话目录，也不选目录接入。

## 待用户确认的边界

- 验收用哪个实例与哪些工作区。
- 引擎先于实例启动、以及引擎在中途重启这两种时序是否同样适用。
- 第 3 条的「只依赖同步工作区」是否同样收窄 Codex 侧的只读增量导入（Codex 是另一真源）；本轮注释未说明。
- 工作区被加入后，该工作区中**已存在**的会话是否随工作区一并映射进真源，还是只映射加入之后产生的会话；本轮只说明「新增一个文件夹并把 DSH 会话映射成它自己的存储形式」，未界定历史范围。
- 第 8 条落地时，原先依赖「无记录 = all」的存量实例范围清零后，是否需要升级提示或一次性确认（清单由另一任务只读核查，本记录不查数据）。
- 可选的第 11 条是否需要在本轮之后单独立项（实例侧界面入口的归属与验收方式未定）。

（本轮已由用户答复的边界：覆盖的可见方式见第 7 条；同步范围默认见第 8 条；文件夹层级见第 9 条；同实例两张卡见第 10 条。）

## 验收（待实现后填写实测）

实例在引擎未启动时可正常启动并使用；引擎启动后自动检出并连接成功；确认后按勾选工作区执行覆盖同步，未勾选工作区内容不变；覆盖写入实例活动会话目录后**刷新 WebUI 即可见、且不重启实例**；连接后 DSH 的改动与新会话进入真源；异常退出与恢复仍保留既有证据链。当前无任何一项通过实际实例验收；第 7 条里「已打开会话是否被宿主内存缓存」也尚未实测。
