---
id: DEC-directory-connect-sync-authority
kind: decision
title: 实例以目录选择接入，真源同步以同步工作区为界
status: current
summary: 引擎侧接管不得依赖 Launcher，改为选择 DSH Home 根目录接入；DSH 侧真源改动只认已绑定实例在同步工作区内产生的会话，范围「未显式选择即为空」；接管覆盖写回实例活动会话目录，刷新 WebUI 即可见。
sources:
- path: ../deployment/launcher-hook.md
- path: ../superpowers/specs/2026-09-10-persistent-native-session-space.md
- path: ../superpowers/specs/2026-08-31-session-maintenance-canonical-projection-design.md
relations:
- relation: supersedes
  to:
    record_id: REQ-runtime-workspace-creation
  reason: 实例自带工作区不再自动登记进真源，改为用户显式加入
---

# 实例以目录选择接入，真源同步以同步工作区为界

来源：2026-09-21 用户在 DSH 会话中的注释，以及**同一用户在后续一轮中的回答与修正**（同日，同一 DSH 会话）。本记录的决定、被替代的旧说法及处置都来自该轮用户表述，不是模型推断。需求侧正文见 [[REQ-detached-instance-attach-sync]]。

## 新决定

### 决定一：实例连接改为目录选择式，与 Launcher 解耦

用户纠正：引擎侧接管**不得依赖 Launcher**，否则形成对 Launcher 的依赖耦合；应**像 Vault 绑定一样，通过「选择实例文件夹」的方式连接**。引擎要检出并接管的是**已经在运行的**实例，不要求实例在 Launcher 生命周期内启动，也不以 Launcher 数据目录或外部 hook 为连接前提。

### 决定二：DSH 侧真源改动只认同步工作区内的绑定实例改动

- 引擎真源中来自 DSH 侧的改动，只依赖**已绑定**实例在**同步工作区**内产生的会话改动；其他实例、其他工作区产生的 DSH 改动不进入真源。
- 同步工作区**默认全部不勾选**。
- 实例自带的工作区不自动成为 Maintenance 真源工作区，而是该实例的**自有工作区**；未被 Maintenance 维护的工作区里的会话不受影响。
- 进入真源需要用户显式动作：在**原本的右键操作菜单**选择「将当前工作区加入 sessionmaintenance」，Maintenance 引擎启动时接纳选中的工作区。
- Maintenance 保有自己的会话原件（真源存储），靠 adapter 与实例交换改动；被加入的工作区在 **Maintenance 自己维护的会话存储区域中新增一个文件夹**，并把 DSH 会话**映射成它自己的存储形式**。
- 与同步配套的覆盖语义是对称的：真源未归档而本地已归档时，覆盖后**恢复为未归档**。

**2026-09-21 后续一轮对该决定的细化（同一用户）**：

- 同步范围的默认是**空**，不是 all：不存在「历史默认范围／legacy all」这种概念，「没有显式选择」一律就是空，新接入与存量实例一视同仁。某实例同步哪些工作区，就等于它在 Maintenance 面板里显式选择的那批，增减都在面板里改。**后果**：原先依赖「无记录 = all」的已接入实例，升级后范围变成空，直到用户在面板里勾选（受影响实例清单由另一个任务只读核查，不在本记录）。
- **连接入口的层级**：选择的是 **DSH Home 根目录**（其中包含 `profiles/` 与 `sessions/`），因为 profile 层无法区分同一 Home 下的多个 profile；选择栏旁必须有文字提示，建议「选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别」。
- **同一实例重复出现**：同一实例出现两张卡时，按 `(instanceId, profileId)` 合并为一张卡并标注连接来源（Launcher / 目录式），不按连接来源各出一张卡。
- **可选**：用户提到连接之后「可以让 DSH 侧也提供修改同步范围的选项」。记为**可选**，不是本轮必须实现；若实现需要新增实例侧界面入口。

### 决定一之二：接管后的「覆盖」写回实例活动会话目录，「刷新」即可见（用户修正，2026-09-21 后续一轮）

用户否掉了「接管 = 引擎只做真源覆盖、实例原生文件不重写」这一框架，原话是「刷新一下 WebUI 页面就可以改了」；他的经验来自以前让别的会话把其它实例的会话复制进来，也是这样生效的。据此：

- 覆盖写到**实例当前实际使用的会话目录**；**不需要重启实例**，刷新 WebUI 即可见。本机真实布局（用户给出的路径比实际少一层）：`<DSH_HOME>\sessions\<工作区目录>\<会话目录>\session.v3.jsonl.zstd`，该实例是每会话一个目录的普通文件存储，未使用引擎 native space。
- 已核实（本机只读）：DSH 的 JSONL 持久化按需 `readdir` 列目录、没有启动期索引——`@deepseek-ai/dsh-session-persistence-jsonl` 的 `listProjectDirs` / `listSessionDirs` 均为目录扫描，所以刷新会重新扫盘，用户的经验有据可循。
- **尚未实测**：已经打开的会话是否被宿主缓存在内存里。建议用一个未打开的会话验证，且不重启实例。
- 写回格式不是新缺口：adapter 侧已有可写原生 v3 格式的编解码（`packages/adapter-dsh-0-1-5/src/native-session-codec.ts` 的 `encode` / `verifyEncoded`）。因此本决定改变的是**接管的写入位置与可见方式**，不是「必须先造出写原生会话的能力」。
- 与用户经验的差别（登记，不据此改写用户要求）：他以前是把**整个会话目录复制进来**，这天然是新增路径；本要求是**就地覆盖**一个该实例正在使用、且可能正被引擎读取的会话。目录扫描这一环已核实，「就地覆盖后是否对已打开会话即时生效」仍待实测。

## 被替代的旧说法

| 旧说法 | 位置 | 处置 |
| --- | --- | --- |
| 实例主动创建的新工作区自动写入 Maintenance 并加入该实例同步名单 | [[REQ-runtime-workspace-creation]]（2026-09-19 用户确认并要求实施） | 已被用户删除；该记录已归档，正文存 `archive/records/`，本记录为后继 |
| 「2026-09-20 起，实例主动新建的工作区是明确例外：Engine 先持久登记工作区…再加入发起 run 的有效范围及实例保存名单」 | [[MOD-instance-workspace]] 该段 | 该段被替代，模块其余职责（策略快照、有效范围、host 绑定）仍有效，记录未归档 |
| 「存在未解决恢复时拒绝覆盖原生目录」及验收项 N09「第二个写入者被拒绝，原生目录不被覆盖」 | `docs/superpowers/specs/2026-09-10-persistent-native-session-space.md` | 与「覆盖式同步」冲突，按本轮注释不再适用；该规格是外部绑定来源，保留原文不改写，冲突在此登记 |
| 接入即写 `maintenance-required.json`，实例侧据此在启动时抛错 | `plugins/dsh-session-maintenance/src/registered-startup.ts` + `apps/engine/src/integrations/service.ts` | 属于待取消的实例侧启动门；用户要求排到「引擎侧检出 + 接管 + 覆盖同步」之后 |
| 「run the formal integration repair before starting」作为实例启动的前置 | `docs/deployment/launcher-hook.md` | 该文档已自行标注为「待生效的要求」；本决定确认它不再是接管的必要前提 |
| 「接管 = 引擎只做真源覆盖、实例原生文件不重写」 | 本轮（2026-09-21 后续一轮）之前由模型提出的框架 | 已被用户纠正：引擎按 adapter 原生格式**写回实例活动会话目录**，刷新 WebUI 即生效，不重启实例（见决定一之二） |
| 「为现有未配置实例保留原来的全部同步行为」／「未配置实例 = all（legacy all）」 | `docs/superpowers/specs/2026-09-18-extension-pages-and-instance-scope.md`（[[IF-instance-workspace-scope]] 的绑定来源） | 与「未显式选择即为空」冲突；该规格是外部绑定来源，保留原文不改写，冲突在此登记 |

**不构成冲突的既有说法**：2026-08-31 稳定真源规格第 9、13 节本就写明「Launcher 只是启动协调器，不是会话真源」「Launcher 启动时可预先唤醒 Engine，但 Projection Lifecycle 由 DSH 插件执行；绕过 Launcher 启动时仍使用相同语义」。决定一与该原则一致，被替代的是**当前实现**把连接与启动绑在 Launcher 目录与外部 hook 上的做法。

## 与现有实现的关系

### 待替换 / 待新增

- **连接入口**：目前只有 Vault 侧有目录选择形态——`apps/engine/src/vault-folder.ts` 的 `createWindowsVaultFolderPicker` / `inspectVaultFolder`，由 `apps/engine/src/vault-bindings.ts` 在选择文件夹后核对真实身份。实例侧 `packages/contracts/src/standalone-instance.ts` 要求调用方直接提交 instanceId/profileId/name/runtimeVersion/homeRoot/versionRoot/runtimeUrl，没有「选目录 → 推导身份与 profile → 检查」的路径。这是决定一要补的缺口。
- **运行态检出与接管**：`inspectStandaloneInstance`（`packages/instance-integration-dsh/src/launcher-discovery.ts`）只做静态检查，不判断实例是否正在运行；`ProjectionLifecycle.attachRun`（`packages/projection-lifecycle/src/lifecycle.ts`）只接受本生命周期 `prepareRun` 产出的 run，否则报 `RUN_NOT_PREPARED`。引擎侧「检出已运行实例并接管」尚无实现。
- **Launcher 耦合点**：`InstanceIntegrationService.action('connect')` 对 `launcherDataRoot !== null` 的目标执行 `desiredLauncherHook` / `installIntegrationPlugin` / `configureLauncherHook`，并写 `maintenance-required.json`（`setMaintenanceRequired`，`apps/engine/src/integrations/service.ts`）；实例侧 `assertRegisteredStartup` 正是读这个文件抛错。决定一要求连接不再以这些为前提；其中写 `maintenance-required` 的一步属于用户排后处理的实例侧启动门。
- **工作区登记**：`RuntimeWorkspaceRegistration` 现在的行为是「实例新建工作区即登记并加入发起 run 范围」（[[MOD-instance-workspace]]），与决定二的「默认不勾选、显式加入」相反，待改。
- **维护工作区存储**：Maintenance 侧「为被加入的工作区在自有会话存储区新增一个文件夹并把 DSH 会话映射成自己的存储形式」尚未实现；相关能力现状见 [[MOD-canonical]] 与持久原生空间规格。
- **写回实例活动会话目录**：接管目前不写实例会话目录，连接也不走目录选择。写回所用的原生格式编解码**已存在**（`packages/adapter-dsh-0-1-5/src/native-session-codec.ts` 的 `encode` / `verifyEncoded`），缺的是接管路径与实例目录定位。
- **范围默认**：现行策略把「未配置」当 all 处理（[[IF-instance-workspace-scope]] 的绑定规格原文），与「未显式选择即为空」相反，待改；改后原有未配置实例的范围会变空。
- **同实例合卡**：目录式与 Launcher 式若各自成卡，需按 `(instanceId, profileId)` 合并并标注来源；现有接入/列表入口尚无该合并，待改。

### 可保留为兼容

- `discoverLauncherIntegrations` 的 **standalone 合成路径**（`standalone` 参数：`launcherDataRoot: null`、`host.digest: null`、`launcherDetected: false`）与 `standalone-instances.json` 登记（`apps/engine/src/integrations/standalone.ts`）已经不要求 Launcher 目录与 hook——`service.ts` 对 `launcherDataRoot === null` 的目标直接判 `hookReady = true`。这条路径可作为目录选择式连接的底层检查与登记机制保留，只需前面补上目录选择与身份推导。
- **Launcher 目录读取**（`discoverLauncherIntegrations(launcherDataRoot)` 读 `config.json`）与 **external-lifecycle hook**：作为「显式经 Launcher 启动」的兼容方式保留，`docs/deployment/launcher-hook.md` 描述的协议不废弃；改变的是它不再是接管的必要前提。
- **RC2 运行时回执、接入插件检查、启动门合同指纹**（[[IMP-startup-gate-split]]）：与连接方式无关，保留。

## 影响范围

[[REQ-detached-instance-attach-sync]]、[[MOD-instance-workspace]]、[[REQ-maintenance-source-list]]（默认勾选语义与入口）、[[OBJ-session]]（工作区归属与写入权）、[[MOD-canonical]]（真源存储布局与 DSH 映射）、[[IMP-startup-gate-split]] 描述的接入流程。Launcher hook 文档 `docs/deployment/launcher-hook.md` 的「待生效的要求」一节已引用本要求。

## 尚未实现

本决定没有任何已实现或已验收的部分：目录选择式连接（选 DSH Home 根目录＋旁注提示）、运行态检出与接管、覆盖式同步（写回实例活动会话目录）、同步工作区「未显式选择即为空」、右键加入入口、同实例按 `(instanceId, profileId)` 合卡并标注来源、Maintenance 自有工作区文件夹与映射，全部待做。用户已明确实施顺序：先做引擎侧「检出 + 接管 + 覆盖同步」，取消实例侧启动门排在其后。用户提出的「DSH 侧也提供修改同步范围的选项」是**可选**，不在本轮范围。

## 核对时的证据差异（未据此改写用户要求）

- Vault 绑定现状是「选择文件夹 + 与在线 Bridge 身份互相证明 + 可离线读取已保存绑定」，实例连接要复用的主要是**选择文件夹**这一形态；实例侧没有等价的在线身份证明机制，因此不能宣称「与 Vault 绑定同构」，只能记为同一类交互。
- `docs/superpowers/specs/2026-08-31-...-canonical-projection-design.md` 第 14.5 节要求「核心流程不依赖右键菜单或操作系统原生弹窗」。该条约束的是维护看板的浏览器验收路径，而本轮用户要求把入口放在 **DSH 工作区的右键菜单**；两者不是同一界面，未按冲突处理。现有 `SESSION_MENU_ITEMS`（`plugins/dsh-session-maintenance/src/client/context-menu.tsx`）是会话级菜单项且经 `dsh-session-context-menu` 桥按精确会话目标校验，工作区级入口属于新增面，尚无实现。
- **会话目录布局的实际层级与用户口述不一致**：用户给的是 `<DSH_HOME>\sessions\<工作区目录>\session.v3.jsonl.zstd`；本机真实存储是每会话一个目录——`<DSH_HOME>\sessions\<工作区目录>\<会话 UUID>\session.v3.jsonl.zstd`（例：本机 `0.1.5-rc.2 测试` Home 的 `--D-DeepSeekDemoWorkplace--` 下若干会话目录）。用户表述用于「覆盖落到实例活动会话目录」这一结论仍然成立，但定位文件时不能按口述少一层。
- **用户的可见性经验不完全是同一场景**：他依据的是「以前把其它实例的会话复制进来」，那是**新增**整个会话目录；本要求是**就地覆盖**该实例正在使用的会话。已核实的只是目录按需扫描（无启动期索引），因此「对已打开会话是否即时生效」仍未实测，测试建议用未打开的会话。
- **依赖缺陷提示**：本机 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `listSessionDirs` 会**拒绝**旧扁平布局（`project` 目录下直接出现 `session*.jsonl(.zstd)` 会抛 legacy 错误）。写回必须落在**会话目录内部**，不能按用户口述的少一层路径直接落文件，否则会触发该错误。
