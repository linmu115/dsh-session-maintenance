# DSH Session Maintenance

本地会话维护引擎：统一管理 DeepSeek Harness 会话的稳定身份、不可变版本、恢复点和可复用的原生历史，并为跨会话引用、会话贴纸、Obsidian 关联和 ThoughtDAG 提供结构化数据真源。Codex 原始会话仍由 Codex 管理，Maintenance 只读导入，不改写其日志。

当前开发分支适配 **DSH 0.1.5-rc.2**，源码版本为 **Engine 0.1.33-rc2.20 / Maintenance 插件 0.2.26-rc2.16**。本次变更见[原生 Agent 上下文管理](docs/changes/2026-09-15-native-context-management.md)，已安装到运行副本的版本与验证结果见[副本安装验收](docs/changes/2026-09-15-native-context-copy-deployment.md)。源码版本不代表同版本已发布到 npm 或 GitHub Releases。

全部配套项目的当前分支、源码版本和使用说明见 [GitHub 源码与 README 索引](docs/reports/2026-09-15-github-source-index.md)。

## 当前功能

- **会话历史**：按逻辑工作区浏览正文、比较版本、创建 Checkpoint、逻辑删除和恢复。DSH 未运行时也可使用 Maintenance 看板。
- **持久原生空间**：Launcher 启动时先处理未提交尾部，再按身份及内容摘要同步真源差异。DSH 直接打开已准备的原生文件，正常退出保留该空间；历史可用性不受旧的 200 条正文预载限制影响，内存仍按需加载。
- **独立扩展数据**：上游引用、Obsidian 关联、贴纸与 ThoughtDAG 使用统一存储中的独立对象类型和版本，由对应扩展 Adapter 解释。停用插件保留数据，图布局和笔记链接不混入原生聊天事件。
- **按所属会话浏览扩展**：每个业务 Adapter 一个面板，Obsidian 系列汇总引用、贴纸和笔记关联，ThoughtDAG 管理主干图。选择实例与配置后，按工作区、所属会话逐层展开；披露记录在主干图下查看。X → Y 的引用归 Y，X 是来源。
- **清爽的会话阅读**：真实提问与最终回答直接显示；运行上下文、技能目录和工具过程集中在默认折叠的“本轮过程”中。展开后按需读取，大结果分页；用户自行输入相同英文或标签不会被当成系统内容隐藏。
- **用户请求与上下文状态**：阅读页可展开真实用户请求索引，按稳定消息定位执行与回复；目录和长请求均按需分页。Obsidian 系列下的上下文使用状态分别显示授权上限、活动窗口、实际保留材料和生效回执，操作入口在对应会话的思维图中。详见[请求索引与原生上下文看板](docs/changes/2026-09-15-native-context-dashboard.md)。
- **每会话主干图**：卡片绑定真实会话，连线表示有方向的上下文关系。图由手动创建、跨会话引用或会话贴纸产生，不维护全部会话的全局总图。
- **有界上下文披露**：引用固定到来源回复完整结束，选区标记重点。初始准备该回复所在问答轮次，AI 后续通过工具读取或搜索更早内容，受容量预算、固定上限和防循环规则约束。
- **删除与归档同步**：解除引用会停止后续传递并更新图。归档会话会撤销以它为来源或目标的活动引用、清除相连待绑定边，并归档自身主干；恢复会话不会自动复活已撤销的引用。

图只保存节点、边、来源身份、固定截止位置及有限的披露范围日志，不按每轮复制全部上游历史或生成完整上下文备份。笔记正文仍由 Obsidian Vault 管理。详见[设计与功能需求](docs/superpowers/specs/2026-09-10-session-context-graph-requirements.md)及[插件改动清单](docs/superpowers/specs/2026-09-10-session-context-graph-plugin-changes.md)。

## 使用流程

1. 安装匹配的 Engine、Maintenance 插件与所需扩展。在 Launcher 的目标 Profile 中选择会话来源 `Session Maintenance`，端点 `auto`；DSH 0.1.5-rc.2 对应 Adapter 为 `dsh-0.1.5`。
2. 从 Launcher 启动 Profile。启动准备和宿主回执验证完成后，历史按原生方式读取。本轮新增内容提交到 Maintenance，取得持久化回执后才视为提交成功。
3. 在已完成的回复中选文，使用跨会话引用入口，先选工作区、再选目标会话，目标输入框显示引用气泡。创建独立会话贴纸时，也先选择新会话所属工作区。
4. 在目标会话页切换“思维图”。空白处右键添加空卡片或已有会话；节点右键进入会话、查看来源或移除卡片；边上右键移除连接。空卡片在真正开始会话时才创建 DSH 会话，开始操作准备上下文并跳转，不自动发送。
5. 来源选文的蓝色引用号可跳转到贴纸会话，右键可删除指定引用。同一选文的其他引用及普通红色贴纸保留。移除卡片或边会解除对应后续上下文关系，不删除真实会话。
6. 从 Launcher 或 DSH“设置 → 会话维护”打开看板，在扩展数据中选择实例与配置、Obsidian 系列或 ThoughtDAG，再展开工作区和会话。选择条目读取详情；主干图的披露记录需进一步展开。可用操作取决于对应成员的安装、启用和兼容状态。
7. 阅读会话时，点击“本轮过程”查看运行材料与工具目录，点击具体记录读取正文或原始数据，长内容可继续分页。引用镜像在看板只读，需要修改或删除时使用原来的会话或 Obsidian 引用入口。
8. 在思维图右键来源卡片选择“管理来源上下文”，查看请求目录、选择不连续窗口、暂停或释放来源材料、固定重要片段。原生 Agent 通过九个标准工具管理自身主干；释放后待下一请求前应用，再显示已生效，图边和原始历史保留。

启用 Core 的轻量引用同步需在 Maintenance 的 `extensionPlugins` 中配置 `annotation-records`，`writerId` 为 `dsh-annotation-core`，`pluginVersion` 与已安装 Core 一致。启动会补齐当前条目，后续变更自动同步；未映射会话或暂时离线会重试。镜像只保存有限选区、评论、定位与状态，不备份整篇笔记或提交日志。工作区归属跟随当前会话目录，未知归属显示在“待绑定 / 待核验”。

原生上下文管理另配置 `annotation-context`，使用同一个 Core 写入方和版本。它仍显示在 Obsidian 系列面板中。模型元数据和请求索引分页，实际材料释放使用原生替代事件及持久回执；累计读取额度不会随释放重置。此新增能力仅用于原生 Agent，托管引擎暂不启用。

Obsidian 的“关联笔记”用于双向导航；要向模型提供笔记内容，使用“引用到会话”。Obsidian 引用由指定内嵌会话领取，独立 DSH 窗口不会抢领。见 [Reference Suite](https://github.com/linmu115/dsh-obsidian-session-reference-suite/tree/codex/rc2-session-context-graph) 和 [Vault 插件](https://github.com/linmu115/obsidian-deepharness-bridge/tree/codex/dsh-0-1-5-rc2)。

## 当前配套版本

以下是当前副本使用的组合，不表示可任意替换同名上游版本。

| 组件 | 版本 | 责任 |
| --- | --- | --- |
| Maintenance Engine / DSH 插件 | 0.1.33-rc2.20 / 0.2.26-rc2.16 | 会话与扩展真源、原生空间、提交回执、看板 |
| Annotation Core | 0.3.12-rc2.11 | 引用集、发送准备、按需读取及预算 |
| Session Sticker Board | 0.7.3-rc2.17 | 独立会话贴纸、来源高亮、蓝色引用号 |
| ThoughtDAG | 0.4.14-rc2.9 | 每会话主干图、节点和连线交互 |
| Sidechat | 0.4.7-rc2.11 | 选区注释与侧边交互 |
| Obsidian Bridge Lifecycle | 0.3.3-rc2.15 | 引用交接与生命周期 |
| Obsidian Reference Adapter | 0.3.4-rc2.15 | Obsidian 来源接入 |
| Obsidian Session Reference Suite | 0.3.4-rc2.17 | 匹配的成员组合与加载拓扑 |
| Obsidian Vault 插件 | 0.6.4-rc2.6 | 笔记侧选择、标记、关联与内嵌会话 |

Suite 和成员需要保持规定的父子加载关系。第三方原版 ThoughtDAG、旧 RC1 插件和当前定制 RC2 包不能仅按名称互换。Codex 执行与预算支持由可选的 [dsh-codex-runtime](https://github.com/linmu115/dsh-codex-runtime/tree/codex/rc2-session-context-graph) 提供。

## 数据与组件边界

| 组件 | 责任 |
| --- | --- |
| Engine | 规范身份、导入与提交、版本、删除与归档、运行租约、恢复、本地 API 和扩展存储 |
| Dashboard | 通过 Engine API 展示目录、维护操作及扩展面板，不直接读写会话库 |
| DSH 插件 | 接入官方生命周期、恢复目录元数据、捕获新增事件、确认提交和关闭排空 |
| DSH 版本 Adapter | 解读原生格式、编码原生文件、规范化追加、解析稳定锚点 |
| 扩展 Adapter | 解释引用、贴纸、链接和图对象，声明兼容性及展示方式 |
| Maintenance Provider / Launcher Hook | 管理 prepare、attach、drain、close、recover，传递运行配置及回执 |

原生空间按实例、Profile、分支和格式隔离，由 Maintenance 托管在 `projection-runtime/native-spaces/<space-key>/sessions`，通过宿主持久化配置接给当前 Profile。它不属于插件安装目录；第三方插件应遵守当前实例的持久化接口，不能写死 `$DSH_HOME/sessions`。

**导入来源**与**启动原生空间同步**是两个步骤：启动只将已纳入 Maintenance 的规范内容同步成 DSH 格式，不能据此认定 Codex 新正文已全部导入。运行期间插件直接向 Engine 提交，不逐条经过 Launcher；首次续写只读 Codex 来源时保留来源与派生关系。见[持久原生空间](docs/changes/2026-09-10-persistent-native-session-space.md)、[RC2 原生来源保留](docs/changes/2026-09-12-rc2-native-source-preservation.md)和 [Adapter 架构](docs/adapters/architecture.md)。

## 构建与安装

工作区 bootstrap 最低要求 Node.js >=22.19.0；当前 Maintenance 插件要求 Node.js >=24.7.0，构建和运行整套 RC2 组合应使用后者。包管理器为 pnpm 11.19.0。Engine + Dashboard 与 DSH 插件分别打包，保留的 `phase2` 脚本名不代表当前仅运行早期 RC2 Gateway。

```powershell
pnpm bootstrap
pnpm check
pnpm package:phase2
pnpm verify:phase2-package
```

目标 RC2 运行还需要匹配的 Launcher Provider、完整宿主构件及当前实例回执，不能只复制插件目录代替整组接入。步骤见 [INSTALL](docs/deployment/INSTALL.md)、[UPGRADE](docs/deployment/UPGRADE.md)、[RECOVERY](docs/deployment/RECOVERY.md)、[Launcher Hook](docs/deployment/launcher-hook.md)和[当前 RC2 接入记录](docs/changes/2026-09-12-final-rc2-plugin-binding.md)。历史部署文档保留当时版本，当前组合以本页及对应交付记录为准。

源码保留 alpha2、RC1、早期 RC2 Adapter，适用范围见[历史兼容矩阵](docs/adapters/compatibility-matrix.md)；它们不是 `dsh-0.1.5` 的别名。不启用 EAC、旧 `dsh-codex-session-sync` 或 Native Mirror 运行链。

## CLI 与看板

以下命令使用自行选定的独立状态目录：

```powershell
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" init --json
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" status --json
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" serve --host 127.0.0.1 --port 0 --json
```

Engine 默认从安装位置查找 Dashboard，也可传 `--dashboard-root <目录>`。CLI 优先使用 `--state-root`，其次为 `DSH_SESSION_MAINTENANCE_STATE_ROOT`，否则使用当前目录下 `.dsh-session-maintenance`。便携包默认使用 `%LOCALAPPDATA%\DSH-Session-Maintenance`，支持 `DSM_STATE_ROOT`。不同启动方式应连接同一套选定数据。

`instance add` 登记平台路径，`scan --all --json` 只读扫描来源。`codex-target add` 登记延续目标，`continuation preview` / `continuation create` 用于明确发起新的 Codex 任务。连接描述符 `connection.json` 含访问凭据，不能提交或分享。API 仅绑定本机回环地址，看板通过一次性启动码、HttpOnly cookie 和 CSRF 校验访问。

## 验证与设计记录

`pnpm check` 执行类型检查、构建和测试，使用合成会话和独立目录。交付记录区分自动测试、运行副本核查及尚未代替用户完成的真实模型与业务验收。

- [主干图与上下文披露](docs/reports/2026-09-15-session-main-graph-release.md)
- [纵向布局与 DSH 主题](docs/reports/2026-09-15-vertical-graph-theme-release.md)
- [蓝色引用删除、归档与节点开始恢复](docs/reports/2026-09-15-graph-reference-lifecycle-release.md)
- [可拔插扩展数据需求](docs/superpowers/specs/2026-09-10-pluggable-extension-data-requirements.md)
- [扩展归属目录与会话阅读器规格](docs/superpowers/specs/2026-09-15-extension-ownership-and-session-reader.md)
- [历史验证记录](docs/validation)
