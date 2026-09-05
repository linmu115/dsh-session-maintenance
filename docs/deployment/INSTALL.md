# 安装

本页适用于当前 Canonical 投影体系。已记录运行组合为 DSH `0.1.2-rc.1`、Engine `0.1.14`、Maintenance `0.2.16`、SCM `0.3.1`；它是 2026-09-05 快照，不是任意新版兼容承诺。其他 Adapter 的证据与 Provider 限制见[支持矩阵](../adapters/compatibility-matrix.md)。早期 RC2 Gateway 安装不代表当前启动链。

## 产物与前提

源码声明 Node.js >=22.19.0、pnpm 11.19.0，已有本地部署证据来自 Windows。`pnpm package:phase2` 生成 Engine+Dashboard 与 Maintenance 插件两个 tgz，文件名版本取自各自 package.json；校验 `phase2-manifest.json` 中的 SHA-256，不使用旧文档硬编码的包版本。

Engine 包包含 `engine/dsh-session-maint.mjs`、`dashboard/` 和 `Start-Session-Maintenance.cmd`。SCM 属于配套仓库；Launcher Hook 属于 Launcher，Maintenance Provider 随 Engine。完整组合发布需另记录 Adapter、DSH 和 Launcher 版本。无需 EAC、旧同步插件或 Native Mirror。

## 安装步骤

1. 校验清单并解压到一个新的版本目录。保留原构建以供回退。
2. 选择持久 state root。启动脚本默认使用 `%LOCALAPPDATA%\DSH-Session-Maintenance`；可提前设置 `DSM_STATE_ROOT`。首次空目录可用以下 CLI 初始化；不要在已有部署中改指向另一份空库。

```powershell
node .\engine\dsh-session-maint.mjs --state-root "<维护状态目录>" init --json
```

3. 通过可信 CLI `instance add` 登记需要读取的来源。Codex 是只读源；首次导入和后续正文导入应按对应导入流程执行。`scan`、标题同步及启动投影不应被视作相同操作。现有导入脚本另开存储连接，在线并发入口尚待计划中的统一调度，不应据此声称已提供新的在线导入命令。
4. 使用与目标 DSH 安装匹配的官方 CLI 安装已校验插件。下面 `$dshBin` 表示该安装实际的 `lib/bin.js`，`web` 是选定 profile；不要复制旧 RC2 runtime 路径套用到 RC1。

```powershell
node $dshBin plugin --profile web add "<Maintenance插件tgz>"
```

5. 按 [Hook 接入](launcher-hook.md)配置匹配的 Launcher 宿主和本仓库 Provider，使运行按 prepare / beforeStop / afterExit / abort 收尾。Provider 返回运行投影及插件所需启动环境；不要只设置连接路径后绕开投影准备来启动 Canonical 运行。
6. 独立看板可使用包内启动脚本，或明确使用同一个 state root：

```powershell
node .\engine\dsh-session-maint.mjs --state-root "<维护状态目录>" serve --host 127.0.0.1 --port 0 --dashboard-root ".\dashboard" --json
```

便携脚本已显式指定包内 Dashboard。`a6b4053` 候选构建还支持省略目录后的自动发现，但历史运行进程不会自动获得该修复。避免同时为同一状态目录另启 Engine。

## 验收

确认插件加载、准确会话身份、只读来源可见、首次续写派生、追加回执及正常退出排空。保留 RC1 官方空会话生命周期，不靠伪造消息使其持久化。设置页直接打开看板后，验证认证跳转、页面和应用脚本均成功；未认证业务 API 仍应拒绝。

菜单入口的共享整理尚有后续工作，不能保证 Maintenance 专有右键动作在所有组合均可见。设置页看板入口应单独验证。Engine 会轮换 `connection.json` capability，插件 host 按描述符更新时间重读；不要向浏览器、设置或 Git 复制 token。
