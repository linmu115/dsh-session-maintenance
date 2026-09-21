# 启动门分离与「引擎后接管」新要求（本轮开发历程草稿，未索引）

来源：2026-09-21 当前 DSH 会话的公开正文与三轮用户回答。尚未绑定可展开的宿主事件索引；本机不支持导入 DSH 会话，不伪造 history-event 回执，因此本段是过程草稿，不作正式历程记录。（第三轮的用户决定在本机 Codex 侧被索引的会话文件里检索不到——该会话文件最后写入早于本轮，因此只能按用户归因记录，不能声称已索引。）

## 问题

MNT-001：已注册实例安装普通业务插件（如 DSH Bridge）后，managed-instance check 仍为 `needs-attention`，实例无法启动。原因是适配层把 `extraBundles`、配置 patch 与插件清单整体计入启动绑定 fingerprint，要求与注册记录逐字节相同。

## 尝试与修正

第一版把启动门收缩为「实例身份 + 宿主/格式合同」，把 patch 摘要与接入插件解析结果一并移入仅记录的库存。测试立刻给出两次失败：写用户 patch 层、替换接入插件包身份都不再移动门槛。为排除「本来就失败」的误判，用 `git stash push` 只回退两个源码文件，回到基线重跑同一批用例，得到「基线通过、改动后失败」，确认是本次引入的回归。随后重新划分：用户 patch 层能真正关闭持久化/会话服务，接入插件自身是本合同的对接方，二者属于合同；只把普通业务插件的组合移出。改后 `apps/engine/test/integrations.test.ts` 34 项通过，`packages/contracts`、`packages/instance-integration-dsh`、`apps/engine` 类型检查 exit 0。

## 用户反馈与人工纠偏

用户先要求「稍等，先汇报」；随后在注释中指出本会话汇报里「接入当前实例会把实例启动变成依赖 Maintenance 引擎可达」的说法不符合其目标架构，明确「sessionmaintenance 不阻碍实例的启停行为」。用户同时给出新架构要求：实例先启动、引擎后启动；引擎启动后自动检出已启动的实例并连接；连接后执行真源同步并经实例侧 Session Maintenance 插件弹窗确认；引擎启动前在已勾选工作区内产生的实例侧改动（含新增会话、归档会话、已有会话内的新会话）由真源覆盖；连接成功后恢复 DSH 改动与新会话进入真源。该要求已登记为 [[REQ-detached-instance-attach-sync]]，当前实现与之相反。

## 结果与边界

实现见 [[IMP-startup-gate-split]]，证据见 [[VER-startup-gate-split]]。改动未提交、未构建进发行包，本机发行版引擎 .58 / 接入 .36 不含此修复；未做真实实例验收（没有注册实例、没有复现「安装 Bridge 后仍可启动」）。按用户要求，本轮未启动引擎、未接入、未重启任何实例，只做了只读现场核查。

## 第二轮：用户注释逐条确认边界与一次纠正

用户在该轮注释中逐条回答了 [[REQ-detached-instance-attach-sync]] 的待确认边界，并纠正了一处说法。

**确认（同意、无修改）**：引擎缺席时插件侧留下可供引擎发现的握手/租约。

**纠正（人工纠偏）**：此前记录里「接管依赖 Launcher」的说法被用户否掉——引擎侧接管不得依赖 Launcher，否则形成依赖耦合；应像 Vault 绑定一样通过「选择实例文件夹」连接。据此只读核对了三处仓库证据：`apps/engine/src/vault-bindings.ts`（Vault 用 `createWindowsVaultFolderPicker` + `inspectVaultFolder` 选目录并核对身份）、`packages/instance-integration-dsh/src/launcher-discovery.ts` 的 standalone 合成路径（`launcherDataRoot: null`、`host.digest: null`、`launcherDetected: false`）、`apps/engine/src/integrations/standalone.ts`（`standalone-instances.json` 登记）。结论：standalone 路径已不要求 Launcher 目录与 hook，可作为底层机制保留；缺的是「选目录 → 推导身份与 profile」这一段，以及引擎侧的运行态检出与接管。核对同时确认了耦合的另一端：`service.ts` 在 connect 时写 `maintenance-required.json`，正是实例侧 `assertRegisteredStartup` 抛错的依据。

**同步权威与工作区登记（用户要求删除旧规则）**：真源中来自 DSH 侧的改动只依赖已绑定实例在同步工作区内产生的会话改动；同步工作区默认全部不勾选；实例自带工作区是该实例的自有工作区，不自动登记进真源；经原本的右键操作菜单「将当前工作区加入 sessionmaintenance」显式加入，由引擎启动时接纳；Maintenance 保有自己的会话原件，被加入的工作区在 Maintenance 自有会话存储区新增文件夹并映射 DSH 会话。明确替代「原生新会话登记进真源（`importDshNative`）」与「未完成恢复则拒绝覆盖原生目录」。非同步工作区里的会话不受影响。归档状态按真源对称覆盖。

**实施顺序（用户要求）**：先做引擎侧「检出 + 接管 + 覆盖同步」，理由是不需要重启实例、不挂 hook 就能验收；取消实例侧启动门排到后面，用户担心先挂 hook 会导致实例起不来、没法工作。

## 结果与边界（第二轮）

新增 [[DEC-directory-connect-sync-authority]] 记录决定、被替代的旧说法与影响范围；受影响记录按替代关系更新，[[REQ-runtime-workspace-creation]] 用 archive-record 归档（保留原身份与存档正文）；[[REQ-detached-instance-attach-sync]] 按注释改写，已答项收敛为结论并标注来源为 2026-09-21 用户在 DSH 会话中的注释。本轮**只改项目地图记录**，未改代码、未提交 Git、未动其它项目地图，也未改 `docs/handoffs/**`。除只读核对上述源码外，没有启动引擎、接入实例或重启进程，因此本决定**无任何已实现或已验收部分**。

核对中与仓库证据不一致、因而未按原话采纳的两点：一是 Vault 绑定实际形态是「选目录 + 与在线 Bridge 身份互相证明 + 可离线读取已保存绑定」，实例侧没有等价的身份证明机制，所以只记为同一类交互，没有写成「与 Vault 绑定同构」；二是 2026-08-31 规格第 14.5 节要求维护看板核心流程不依赖右键菜单，与本轮要求的「原本的右键操作菜单」不是同一界面（前者是维护看板浏览器验收，后者是 DSH 工作区菜单），未按冲突处理，工作区级入口本身尚无实现。

## 第三轮：用户答复五条边界，并否掉一个框架

触发：第二轮把五条边界留成了待确认问题，用户在本轮一次性回答，其中一条是对模型先前框架的直接纠正。

**用户的五条决定（2026-09-21 用户在 DSH 会话中的回答）**

1. **纠正（人工纠偏）**：先前记录的「接管 = 引擎只做真源覆盖、实例原生文件不重写」被否掉。用户原话是「刷新一下 WebUI 页面就可以改了」，并说明他以前让别的会话把其它实例的会话复制进来时就是这样生效的。结论：覆盖写到实例当前实际使用的会话目录，刷新 WebUI 即可见，不需要重启实例。据此重建口径——引擎按 adapter 的原生格式**写回实例的活动会话目录**。
2. **纠正（人工纠偏）**：用户否掉「存量保持 all」。不存在「历史默认范围／legacy all」这种概念，「没有显式选择」一律就是空，新接入与存量一视同仁；某实例同步哪些工作区就等于它在面板里显式选择的那批。必须记录后果：原先依赖「无记录 = all」的已接入实例升级后范围会变空，直到用户在面板里勾选（受影响实例清单由另一任务只读核查，本任务不查数据）。
3. **可选需求**：连接之后「可以让 DSH 侧也提供修改同步范围的选项」——记为可选，不是本轮必须实现，若实现需新增实例侧界面入口。
4. **确认**：选择实例文件夹那一层选 **DSH Home 根目录**（含 `profiles/` 与 `sessions/`），因为 profile 层无法区分同 Home 多 profile；并且要在选择栏旁边给文字提示。
5. **确认**：同一实例出现两张卡时，按 `(instanceId, profileId)` 合并为一张卡并标注连接来源（Launcher / 目录式）。

**本轮的只读证据核查（未改代码、未启动实例）**

- 会话存储布局：本机 `0.1.5-rc.2 测试` Home 下为 `<DSH_HOME>\sessions\--D-DeepSeekDemoWorkplace--\<会话 UUID>\session.v3.jsonl.zstd`，即**每会话一个目录**，未使用引擎 native space。用户给的路径比实际少一层（这一点与用户口述不一致，已在 [[DEC-directory-connect-sync-authority]] 的证据差异里登记）。
- 目录扫描无启动期索引：`@deepseek-ai/dsh-session-persistence-jsonl` 的 `listProjectDirs` / `listSessionDirs` 都是 `readdir`，所以刷新会重新扫盘——用户「刷新即可见」的经验因此有据可循。同一处证据还显示 `listSessionDirs` **拒绝**旧扁平布局（`project` 目录下直接出现 `session*.jsonl(.zstd)` 会抛 legacy 错误），所以写回必须落在会话目录内部。
- 写回格式不是新缺口：`packages/adapter-dsh-0-1-5/src/native-session-codec.ts` 已有 `encode` / `verifyEncoded` 可写原生 v3 格式。
- 与用户经验的差别：他依据的是「把整个会话目录复制进来」（新增路径），本要求是**就地覆盖**一个该实例正在使用、且可能正被引擎读取的会话。据此只把「目录按需扫描」记为已核实，**已打开会话是否被宿主缓存在内存里仍未实测**，建议用一个未打开的会话验证且不重启实例；验证前不得宣称覆盖对已打开会话即时生效。

**结果与边界**

改动落在 [[REQ-detached-instance-attach-sync]]（新增第 7–11 条、收敛已答边界、更新验收）、[[DEC-directory-connect-sync-authority]]（新增决定一之二、细化决定二、新增三行被替代旧说法与「尚未实现」清单）、[[REQ-maintenance-source-list]] 与 [[MOD-instance-workspace]]（按「未显式选择即为空」补充现状与后果），以及 map.md 的当前实现与验收边界一节。本轮**只改项目地图记录**，未改代码、未提交 Git、未动 `docs/handoffs/**`、未动其它项目地图；除只读核对外没有启动引擎、接入实例或重启进程。全部能力仍未实现、未验收。

**本轮与证据不一致因而未采纳的说法**：一是用户给的会话文件路径少一层，按实际层级记录并在 DEC 里写明差异；二是「刷新即可见」的用户经验来自复制整个会话目录，属于新增而非就地覆盖，因此只采纳「目录扫描无启动期索引」这一半，另一半标为未实测。
