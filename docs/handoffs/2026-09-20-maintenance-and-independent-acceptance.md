# Maintenance 交接与后续开发、插件独立验收

## 最新任务方向

用户要求先登记 Maintenance 复杂改动并暂停该部分开发。优先关闭引擎，验证 Core、DAG、两侧 Bridge、普通贴纸独立工作能力；新阻断仍在对应插件停止并报告。
本文件及 ../issues/2026-09-20-managed-plugin-composition.md 替代此前部署报告中“普通插件变化应阻断、用户每次 revalidate”的后续建议。历史证据仍保留。

## 已完成与现场起点

提交 25299ef：兼容判断改为 adapter 接入协议、宿主、格式及能力声明；42 项测试通过，实际 .36 注册/启动/DAG 保存刷新/正常停止通过。
发行目录：D:/AI/DeepSeek-Harness/session-maintenance-compatibility-20260920（candidate-r8）。
Engine .58；接入 .36；Core .21；DAG .17；DSH Bridge .4 已安装；testvault Companion .5 已安装启用并保留原绑定、历史；Sticker .6 尚未安装。
测试实例 ID：i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5；profile web。
DSH Home：C:/Users/19717/AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.1.5-rc.2 测试。
DSH runtime：C:/Users/19717/OneDrive/文档/ChatGPT/dsh/.artifacts/rc2-launcher-deployment/runtime。
Maintenance state：C:/Users/19717/AppData/Local/DSH-Session-Maintenance。
有效维护库：metadata.projects-20260906-0-1-19.sqlite；不要误用同目录 metadata.sqlite。
Vault：D:/obsidian/testvault；不得更改其他 Vault。
受管目标：dsh-0a1ff7d0adab3684267dd4695fef1b7f；勿操作 Launcher 发现的另一同名目标。

## 转独立模式

先确认已正常停止且 finalReceipt=closed，再通过 managed-instance unregister 正式解除此目标。
按教程将 sessionSource 切为 native；为证明其他插件不依赖 Maintenance，再停用/移除 DSH 接入插件，保留配置备份和维护历史。
正常关闭引擎，不删锁、不强杀。直接用 DSH 官方 CLI 启动 web，在 Codex 内置浏览器展示页面。
使用明确标识的本地测试会话验收；受管投影与普通本地数据目录不会自动合并，不复制底层会话文件假装完成迁移。
业务数据 adapter 同步在本阶段不启用，Codex 不处理。

## 独立验收范围

- Core：本地选文/引用登记、待发送引用；模型实际发送由用户最终验收。
- DAG：本地会话图显示、合法操作、保存、重开；只需 Core。
- Bridge/Companion：引擎关闭时，DSH 设置页发现并连接 testvault；验证断开/重新连接，历史保留；无 CLI 是另外的可选能力用例。
- Sticker：安装在 Core + Bridge 后，创建、保存和重开本地测试贴纸。
- 记录实际安装版本及引擎确实关闭。源码存在可选 Maintenance 接口不等于硬依赖；不得仅据源码候选宣称全体已验收。

## 后续 Maintenance 开发顺序

1. 将普通插件/非关键配置与接入关键合同分离，明确适配层只向引擎给出必要检查结果。
2. 为普通插件新增/移除/升级、无 adapter 新类型、关键合同真实失效建立合成用例；普通插件变化必须可启动，核心不兼容要有具体诊断。
3. 完成未知数据全链路审计和无损往返测试；缺 adapter 只影响专用理解功能。
4. 验证断连停写、恢复、正常退出和解除注册保护仍有效。
5. 最后决定是否需要诊断性的 revalidate，再补完整用户教程；不能以新增命令替代前面边界修正。

## 本轮执行结果

结果见下文。遇到新插件阻断按用户要求停止，不扩展成未授权重构。


## 实际执行结果（2026-09-20）

- 正式 unregister 成功；随后移除 DSH Maintenance 包和 bundle，接入配置保存在 before-independent-acceptance 备份中，原维护历史保留。
- Maintenance 引擎正常退出，42831 无监听；DSH 用官方 CLI 直接运行，无 Launcher Hook 和 Maintenance 进程。
- Core .21、DAG .17、Bridge .5 当前安装；testvault Companion .5 启用。
- 用户指出 Obsidian 连接设置没有宿主样式；已在 Bridge .5 修复。浅色、深色实际截图复核通过，原“跟随系统”偏好已恢复；当前内容宽 491px，scrollWidth 同为 491px。更窄断点有 CSS 支持，本轮未额外覆盖尺寸验收。
- 在引擎关闭且无 Maintenance 接入插件时，从 DSH 设置页断开 testvault 成功，再连接成功，最终显示“已连接”。没有改动 math Vault 绑定。
- 主会话窗口在独立 UI .5 运行时已加载新会话页面，旧模型 cpa-native/gpt-6-astra 仍不可用。本轮没有调用模型，也没有完成新本地会话内的 Core 引用、DAG 图持久化验收。
- 继续安装 Sticker .6 后启动失败：dsh-session-sticker-board: pending (waiting for service: obsidianBridgeLifecycle)。版本核对无回退；属于贴纸/桥服务就绪的新阻断，未诊断为 Maintenance 耦合，未修改加载逻辑。
- 已通过官方插件命令撤回 Sticker 安装，恢复 Core + DAG + Bridge 可展示的基线。当前 DSH PID 48080，WebUI http://127.0.0.1:19876/；引擎继续关闭。
- 失败日志：independent-sticker.stderr.log；恢复日志：independent-ui-restored.stderr.log/stdout.log。日志含本机信息，分享前应脱敏。
- 当前仅可声明 Bridge 连接管理已通过无引擎真实操作；其他插件全功能独立性未全部验收。不得用“架构已解耦”代替此结果。

## 下一步

2026-09-20 后续修复：用户授权继续解决 Sticker 阻断。确认 Bridge 必需异步初始化不在 Loader 入口等待范围；Bridge 0.4.1-rc2.6 修复。官方命令更新 Bridge 并重装 Sticker 0.7.4-rc2.6，当前独立 DSH PID 48624 正常运行，WebUI 插件列表显示贴纸运行中，testvault 连接保留。Core .21、DAG .17 无回退；Maintenance 继续关闭且接入包未安装。

详细证据：artifacts/architecture-upgrade-20260920/sticker-bridge-startup-fix-20260920.md（位于插件项目根目录）。上文撤回 Sticker、PID 48080 属于此前历史状态。

继续 Core → DAG → Bridge → Sticker 的业务验收；仍不恢复 Maintenance 开发。贴纸创建/持久化/回链尚未实际验收，Core 引用与模型上下文最终交用户验收。旧选中 CPA 模型不可用状态未在本次改动中处理。

后续真实引用反馈：用户已将页面模型选为 DeepSeek-V41-Flash，并报告 testvault 引用未显示。Bridge .7 已部署以消除独立本地接收对缺席 Maintenance 解析接口的请求。当前 DSH PID 48132；其余版本不变，引擎关闭。真实引用仍在 queued，已请用户刷新 Obsidian 内 DSH 网页后核验。完整现场与待办见 artifacts/architecture-upgrade-20260920/native-reference-receive-20260920.md；不要宣称引用已通过验收。

最新验收结果：用户刷新后明确确认“已经出现，会话测试也正常”。随后核验同一引用已 claimed 且有同步回执，0 条等待接收、1 条已同步；Maintenance 仍关闭。上段 queued 为刷新前历史状态，本条独立引用接收和会话测试现已通过；DAG、贴纸其他业务、所有回链跳转及 Maintenance 同步仍按各自未完成范围处理。

后续 DAG 空图修复：用户指出打开测试会话没有所属卡片。DAG .18 已正式安装，ensure 加入所属节点并原地补齐旧修订 1 初始空图。20 项测试、类型检查、构建通过；真实 WebUI 显示修订 2、1 卡片、0 连接，整页刷新重开保持一致。当前独立 PID 11696，其他组件版本不变，Maintenance 继续关闭。名称仍回退为会话 ID，标题读取/重命名是待处理显示缺口；未宣布其他 DAG 业务或同步通过。证据：artifacts/architecture-upgrade-20260920/dag-owner-session-card-20260920.md。

## 2026-09-21 本轮执行：启动门分离与新架构要求

用户授权在下述顺序中先开始第 1 项。

- 第 1 项（普通插件/非关键配置与接入关键合同分离）已实现：`fingerprint` 收缩为实例身份 + 宿主/运行时合同 + 生效用户 patch 层 + 接入插件自身解析结果；普通业务插件组合改记入新的 `pluginInventory`，只用于解释与展示。第一版切分只保留身份与格式合同，被两个既有用例证明切错（用户 patch 层、接入插件包身份不再移动门槛），用基线对比确认是本次引入的回归后修正。
- 证据：`apps/engine/test/integrations.test.ts` 34 项通过（含 2 项新增）；`packages/contracts`、`packages/instance-integration-dsh`、`apps/engine` 类型检查 exit 0。**改动未提交，未构建进发行包；本机发行版引擎 .58 / 接入 .36 不含此修复；未做真实实例验收。** 记录：[[IMP-startup-gate-split]]、[[VER-startup-gate-split]]、[[HIST-maintenance-startup-gate-split]]。
- 用户同时提出新架构要求并纠正本会话中「接入会让实例启动依赖引擎可达」的说法：实例先启动、引擎后启动，引擎启动后自动检出已启动实例并连接，连接后执行真源同步并经实例侧插件确认；引擎缺席期间已勾选工作区内的实例侧改动（含新增会话、归档会话、已有会话内的新会话）由真源覆盖；连接成功后恢复 DSH→真源同步。已登记为 [[REQ-detached-instance-attach-sync]]；当前实现相反，工作尚未开始，也未选定验收实例与工作区。
- 现场：本机引擎未运行；Launcher 目录无 `runtime-lifecycle.json`（当前实例没有外部生命周期 hook）；引擎状态根的绑定与 `maintenance-required.json` 只涉及另外两个实例；当前测试实例 `i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5` 未安装接入插件。按用户要求，本轮未启动引擎、未接入、未重启任何实例。
- 第 2–5 项仍未开始：普通插件增删升级/无 adapter 新类型/核心合同真实失效的合成用例补充、未知数据全链路无损往返审计（MNT-002）、断连停写与恢复/正常退出/解除注册保护复验、诊断性 revalidate 与用户教程的决定。

### 同轮追加：接管式同步的边界与实施顺序

用户在本轮注释中确定（权威记录见 [[REQ-detached-instance-attach-sync]] 与 [[DEC-directory-connect-sync-authority]]，本文件只作摘要）：

- **不依赖 Launcher**：实例连接改为「选择实例文件夹」这一类的目录选择交互，以 Launcher 目录与外部生命周期 hook 为前提的做法不保留为前提。注意现状比此前描述更接近目标：`discoverLauncherIntegrations` 的 standalone 合成路径（`launcherDataRoot: null`、`launcherDetected: false`）与 `standalone-instances.json` 登记已经不需要 Launcher 目录或 hook，`service.ts` 对 `launcherDataRoot === null` 直接视为 hookReady；待替换的是「选目录 → 推导身份/profile」这一段、运行态检出与接管，以及 connect 时写 `maintenance-required.json` 这条实例侧启动门。
- **插件侧握手/租约**：用户同意「引擎缺席时插件也留下可供引擎发现的握手/租约」，否则引擎无法区分被接管的实例与任意 DSH 进程。注意 Vault 绑定的实际形态是「选目录 + 与在线 Bridge 互相证明身份 + 可离线读取已保存绑定」，实例侧目前没有等价的身份证明机制，因此只登记为「同一类交互」，不写成同构。
- **同步权威改为真源单向**：引擎真源的改动只依赖绑定后的实例在**同步工作区**内产生的会话改动；同步工作区**默认全不勾选**；实例自带工作区**不自动**登记为真源维护工作区（作为实例自有工作区，会话不受影响）；在实例侧右键菜单提供「将当前工作区加入 sessionmaintenance」，引擎启动时生效；被加入的工作区要在 Maintenance 自有会话存储里新建文件夹并把 DSH 会话映射为自有存储形式；归档对称恢复。这**替代**了「原生新会话登记进真源」与「未完成恢复则拒绝覆盖原生目录」两条旧规则，并已归档原需求 [[REQ-runtime-workspace-creation]]（实例新建工作区自动回写）。
- **实施顺序**：先做「引擎侧检出 + 接管 + 覆盖式同步」（不需要重启实例、不挂 hook 即可验收），后做「取消实例侧启动门」。用户明确担心先挂 hook 会导致实例起不来而无法继续工作。
- 现状：以上均**尚未实现、未验收**。DSH 侧右键菜单属新增面（现有 `SESSION_MENU_ITEMS` 是会话级且经 SCM 桥按精确会话目标校验）。「只依赖同步工作区」是否同样收窄 Codex 只读增量导入、以及被加入工作区的历史会话是否一并映射，仍待用户确认。

### 同轮追加：第 8 项 (b)「引擎侧按所选实例文件夹匹配实例」按已完成记账

用户 2026-09-21 确认该项**已实现**，只按「已完成、只需验收」记账：

- 引擎侧 `apps/engine/src/instance-lease.ts` 的租约检查同时校验 `instanceId` 与 `profileId`，并把实例应答里的 `homeRoot` 与用户在「选择实例文件夹」时选定的目录比对；不一致时以「应答的 DSH Home 与所选文件夹不一致，已拒绝接管」拒绝接管。
- 待验收：实例重启后实测一次拒绝路径（选错文件夹时引擎不得接管）。本轮未重启实例、未做该项真实验收。
- 边界：不得据此宣布任何同步、接管或覆盖行为已通过验收。

## 转交后续模型：上游绑定的读取通道（尚未实现，待用户拍板设计）

用户 2026-09-21 要求把这一项写进交接，**后续交给更有经验的模型处理**。现状与边界如下，任何接手者都不许绕过：

- **绑定只表达拓扑，不是内容授权。** ThoughtDAG 的「上游绑定」（边 kind `bound`）只记录「本会话的上游是哪个会话」，不含也不授予任何正文；模型侧目前**没有任何**凭绑定读取上游的通道。
- **今天唯一的读取入口是 Core 的引用**：只有当调用者在本轮拿到一个**已提交的引用**（`dsh-annotation` 上下文消息里带它）时，才可用 `dsh_upstream_read` / `dsh_upstream_search` 读取，且读取范围固定在该引用发送时选定的位置。这些工具**只接受已提交引用的 referenceId**，不能凭会话 id 直读；绑定也不授予读取权限。
- **DAG 注入的提示已如实写明这一点**（`dsh/lib/managed-entry.js` 的 `upstreamNotice` 输出「上游绑定：仅拓扑，未读取任何内容」并附边界文字），因此不要从提示反推「链路已通」。
- **待设计的决定（必须由用户拍板，不得自行选择）**：① 是否允许「绑定」本身授予读取权限，还是坚持「只有引用才是读取授权」；② 若允许，读取范围如何界定（哪些会话、哪一段、是否需要实例侧确认）；③ 实现放在 DAG 侧（新工具）还是复用 Core 的引用读取通道；④ 与 Maintenance 的关系——图关系将来由 **adapter** 统一接入 Maintenance 管理，**DAG 插件本身不得与 Maintenance 耦合**。
- 相关记录：ThoughtDAG 地图的 `REQ-upstream-binding` 与 `IF-upstream-notice`；DAG 仓库 `dsh/README.md` 的已知问题（上游绑定对模型不可读，未修复）。**在设计与实现完成之前，任何报告都不得声称「绑定可用于读取上下文」。**

## 作业规则（用户 2026-09-21 明确定下，任何人接手都必须遵守）

1. **实例的启动与停止只能由用户在他那一侧执行。** 助手一侧**任何情况下都不得停止、重启或杀掉实例**；「先停实例再装」这种方案一律作废。
2. **装载类操作（安装插件、替换包文件、改 profile 依赖等）只在助手一侧进行**，并且必须在**实例持续运行**的前提下完成（就地覆盖 + 逐文件哈希校验 + 先备份）。
3. **只有助手完成某项任务后明确提示，才由用户重启实例**；重启动作由用户执行，助手等待其通知。
4. **Maintenance 无权干涉实例的正常启停**：不得写 `maintenance-required.json` 把本实例纳入启动门（除非用户就连接单独批准），不得在任何装载步骤里引入会让实例起不来的前置条件。
5. **连接走插件侧**，不挂 Launcher 外部生命周期 hook。
6. 由此产生的技术约束：运行中安装会遇到 `ERR_PNPM_EPERM`（重命名被占用），因此装载一律走「解包 → 就地覆盖 → 只改 profile 中目标依赖那一行」，**不要**反复重试官方 CLI。

