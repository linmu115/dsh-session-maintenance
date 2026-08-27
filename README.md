# DSH Session Maintenance

一个以不可变版本图管理 Codex 与官方 DeepSeek Harness 会话的本地维护引擎。

当前已完成只读版本图、可恢复事务、官方 DSH `0.1.1-rc.2` 写入链、独立 Dashboard、DSH 入口插件和 Phase 3 Codex 延续任务。DSH 写入只有在 Engine 启动时明确登记对应 Core gateway 才会开启；未登记时保持只读。正式 `web` profile 尚未替换旧同步插件，仓库只生成了可审查的替换预览。

## 支持范围

- Windows 10/11
- Node.js 22.19 或更高版本
- pnpm 11.19
- Codex `0.146.0`
- 官方 DSH `0.1.1-rc.2`

## 从源码开发

```powershell
git clone <repository-url> dsh-session-maintenance
cd dsh-session-maintenance
pnpm bootstrap
pnpm check
```

完整部署请使用 `pnpm package:phase2` 生成的两个独立产物：Engine+Dashboard 和 `dsh-session-maintenance` DSH 插件。安装、升级、卸载和恢复分别见 [INSTALL](docs/deployment/INSTALL.md)、[UPGRADE](docs/deployment/UPGRADE.md)、[UNINSTALL](docs/deployment/UNINSTALL.md) 与 [RECOVERY](docs/deployment/RECOVERY.md)。部署不依赖 EAC、`web-desktop` 或旧 `dsh-codex-session-sync`。

所有运行状态默认位于当前目录的 `.dsh-session-maintenance`；发布包启动脚本默认使用 `%LOCALAPPDATA%\DSH-Session-Maintenance`。也可以用 `--state-root <目录>` 指定独立状态目录。

## 使用

```powershell
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint init --json

pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint instance add `
  --id codex-main --platform codex --root "C:\路径\.codex" --platform-version 0.146.0 --json

pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint instance add `
  --id dsh-main --platform dsh --root "D:\路径\DeepSeek-Harness\home" --platform-version 0.1.1-rc.2 --json

pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint scan --all --json
pnpm --filter @linmu/dsh-session-maintenance-engine exec dsh-session-maint status --json
```

登记一个只接受 ID 引用的 Codex 目标预设：

```powershell
dsh-session-maint codex-target add `
  --id codex-default --codex-instance codex-main `
  --cwd "D:\工作区" --workspace-root "D:\工作区" `
  --context-window 120000 --input-budget-ratio 0.2 --json
```

先预览预算，再明确创建延续任务：

```powershell
dsh-session-maint continuation preview `
  --logical-session <id> --source-version <version-id> `
  --target codex-default --mode full --json

dsh-session-maint continuation create `
  --logical-session <id> --source-version <version-id> `
  --target codex-default --mode full --json
```

`checkpoint` 和 `structured-summary` 是完整模式超出预算时的显式替代；系统不会静默截断。分叉会话使用 `continuation resolution-preview` 和 `continuation resolution-create`，并必须提供左右版本及合并说明。

先通过会话列表或本地 API 获取 logical session 与 binding ID，再运行：

```powershell
dsh-session-maint diff --logical-session <id> --source <binding> --target <binding> --json
dsh-session-maint plan --logical-session <id> --source <binding> --target <binding> --json
```

启动本地 API 与 Dashboard：

```powershell
dsh-session-maint serve --host 127.0.0.1 --port 0 --dashboard-root <dashboard目录> --json
```

需要启用官方 DSH 写入时，再增加受信任的 host gateway 映射：

```powershell
dsh-session-maint serve `
  --host 127.0.0.1 --port 0 --dashboard-root <dashboard目录> `
  --dsh-gateway dsh-web=http://127.0.0.1:3080 --json
```

连接信息写入状态目录的 `connection.json`。API 只绑定 `127.0.0.1`；浏览器使用一次性 launch code、HttpOnly cookie 与 CSRF，不会读取 bearer capability。

## 安全边界

- `instance add` 和管理员使用的 `codex-target add` 是仅有的路径登记入口；平台根、cwd 和 workspace roots 都会解析 realpath。普通 API/MCP 只接受 ID。
- `scan` 只读取平台数据；结果中的 `platformWrites` 固定为 0。
- 标题相同不会自动合并会话，只生成低置信候选。
- DSH `apply` 和 `restore` 只有在显式附着版本锁定的 Core Gateway 后可用；默认 composition 返回 `CAPABILITY_NOT_AVAILABLE`。
- Codex 延续只调用 app-server 创建新任务，不修改 Codex rollout、索引或 SQLite。
- 不要把 `connection.json` 提交到 Git 或发给其他人。

## 验证

```powershell
pnpm verify:clean
pnpm test:phase1
pnpm test:phase2
pnpm test:phase3
pnpm verify:phase2-package
pnpm accept:phase2-isolated
pnpm accept:phase2-official
pnpm assert:portable
```

`accept:phase2-official` 只在本机已设置 `DSH_INSTALL_ROOT` 时运行，并把 DSH_HOME/profile/state 全部放在带标记的 Windows 临时目录；它不会修改正式 profile。详细证据见 `docs/validation/`。
