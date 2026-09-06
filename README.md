# DSH Session Maintenance

一个以 Canonical 会话、不可变版本图和可恢复运行投影管理 Codex 与官方 DeepSeek Harness 会话的本地维护引擎。保留版本比较、Checkpoint、逻辑删除与恢复、稳定引用，以及明确发起的 Codex 延续任务。

当前源码发行组合为 Engine **0.1.20**、Maintenance 插件 **0.2.21**，配套 Launcher **0.2.3** 与 Session Context Menu（SCM）**0.3.2**，本批部署目标为 DSH **0.1.2-rc.1 / web**。原 `4b49927` 的身份与空会话修复以及后续已提交重构保留在提交祖先中。

0.1.19 增加 [Codex 项目映射](docs/changes/2026-09-06-codex-project-mapping-engine.md)：在看板“同步”页勾选 Codex 项目会话文件夹，点击“保存为最新映射名单”，下次实例启动时切换范围。名单包含未来新增本地会话；空名单表示不映射任何项目。当前名单中的变化持续导入，范围外 Maintenance 会话在启动时移入可恢复删除状态，Codex 来源保持只读。项目归属依据显式项目 ID，与工作目录、原生回写工作区名单分别管理。

本批包含静态会话阅读看板、实例接入管理、工作区同步名单及恢复/存储界面整理，验证边界见[看板候选记录](docs/validation/2026-09-06-dashboard-integrations.md)。0.1.18 补齐真实部署发现的[配置型 bundle 误判](docs/changes/integration-bundle-entry-20260906.md)和[既有依赖缓存兼容](docs/changes/integration-existing-store-20260906.md)。实际安装状态以带源码提交和产物摘要的部署记录为准，用户启动与界面验收单独记录。Codex 原生回写和五天正文版本自动删除仍未启用。早期[0.1.15 发布记录](docs/validation/2026-09-06-maintenance-0.1.15-live-release.md)与[审查存档](docs/validation/2026-09-05-maintenance-architecture-review.md)保留当时的事实快照。

## 当前架构

| 组件 | 责任 |
| --- | --- |
| Engine | Canonical 身份、导入与提交、版本/Checkpoint、删除回执、运行租约、WAL、恢复和本地 API；SQLite 与正文对象属于其存储层 |
| WebUI / Dashboard | 通过 Engine API 展示目录、版本、比较、维护操作及状态；可独立构建，不直接读写会话库 |
| DSH 插件 | 接入官方会话生命周期，按需载入投影，捕获追加并确认提交，提供菜单与设置入口 |
| DSH Adapter | 探测指定原生格式、生成投影、规范化追加、验证摘要及解析稳定引用；不决定全局身份或删除规则 |
| Maintenance Provider | 本仓库的宿主接入层，将启动/停止通知转换为 Engine Runtime Broker 操作 |
| Launcher Hook | Launcher 仓库中的通用宿主能力，负责调用时机、协议、超时和失败回收；不读取 Codex 或会话 SQL |

Codex 原始会话是只读来源。**导入**把源内容纳入 Maintenance；**启动投影**把已经纳入的 Canonical 内容转换为本次 DSH 运行需要的格式。当前 `prepare` 前还同步 Codex 标题目录，但不完整导入源正文。投影准备成功不能解释为 Codex 新消息已经全部导入。运行期间插件直接向 Engine 回写，消息不逐条经过 Launcher；首次续写只读来源时保留来源与派生关系。

接入细节见 [Adapter 架构](docs/adapters/architecture.md)、[支持与验证矩阵](docs/adapters/compatibility-matrix.md)和 [Launcher Hook 接入](docs/deployment/launcher-hook.md)。不启用 EAC、旧 `dsh-codex-session-sync` 或 Native Mirror 运行链。

## 支持与发布

开发环境声明为 Node.js >=22.19.0、pnpm 11.19.0；已有本地部署证据来自 Windows。源码内置 alpha2、RC1、RC2 三类 DSH Adapter，不等于任意 Harness 版本或任意插件组合已通过验证。RC1 限定 `0.1.2-rc.1`；alpha2/RC2 的宽探测范围仅提供试验入口，具体证据见矩阵。

Engine+Dashboard 与 DSH 插件是两个独立产物；Adapter/SDK 和 Launcher 宿主有各自版本与验证责任。SCM 来自配套仓库。组合发布必须记录这些版本、源码提交与产物摘要。旧脚本名 `phase2` 不表示现在只运行 RC2 Gateway。

```powershell
pnpm bootstrap
pnpm check
pnpm package:phase2
pnpm verify:phase2-package
```

安装、升级、卸载和恢复见 [INSTALL](docs/deployment/INSTALL.md)、[UPGRADE](docs/deployment/UPGRADE.md)、[UNINSTALL](docs/deployment/UNINSTALL.md)与 [RECOVERY](docs/deployment/RECOVERY.md)。[Generation 打包说明](docs/deployment/canonical-projection-generation.md)单独说明旧组合脚本的适用范围。

## CLI 与看板

下列命令使用调用者选定的独立状态目录；不应把测试目录替换为真实 home 做试验。

```powershell
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" init --json
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" status --json
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint --state-root "<维护状态目录>" serve --host 127.0.0.1 --port 0 --json
```

Engine 0.1.15 默认相对安装位置查找 Dashboard 构建；也可传 `--dashboard-root <目录>`。显式目录无效会报错，不含 UI 的安装仍可只启动 API。旧构建需要显式目录或正常升级后才获得自动发现能力。

CLI 优先使用显式 `--state-root`，其次读取 `DSH_SESSION_MAINTENANCE_STATE_ROOT`，两者均未提供时使用当前目录下 `.dsh-session-maintenance`。便携包启动脚本默认使用 `%LOCALAPPDATA%\DSH-Session-Maintenance`，支持 `DSM_STATE_ROOT`。不要让不同启动方式无意连接不同状态库。

可信 CLI 的 `instance add` 登记平台路径，`scan --all --json` 只读扫描登记源；它与 Canonical 启动投影是不同操作。Codex 目标通过 `codex-target add` 登记；`continuation preview` / `continuation create` 明确发起新任务，完整上下文超预算时需明确选择 `checkpoint` 或 `structured-summary`，不会静默截断。

连接描述符 `connection.json` 含 capability，不应提交或分享。API 仅绑定 loopback；浏览器通过一次性 launch code、HttpOnly cookie 和 CSRF 机制访问看板。标题相同不会自动合并身份。

旧 RC2 Core Gateway 的 `--dsh-gateway <instance=origin>` 仅用于对应的历史事务写入通道，默认未附着时不可用；它不是当前 RC1 Canonical 运行回写的启用开关。CLI `apply` / `restore` 当前仍返回不可用，不应照旧阶段说明直接执行。

## 验证记录

`pnpm check` 执行类型检查、构建和测试；`pnpm test:phase1`、`pnpm test:phase2`、`pnpm test:phase3` 保留分阶段验证入口。历史报告位于 [docs/validation](docs/validation)，其日期、候选状态和未完成的人工验收均应保留，不能据此推断今天的全部组合已经上线。
