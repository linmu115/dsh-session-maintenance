# DSH Session Maintenance

一个以不可变版本图管理 Codex 与官方 DeepSeek Harness 会话的本地维护引擎。

当前已完成只读版本图、通用事务基础和 Phase 3 Codex 延续任务：可以从精确的 DSH 版本创建可追溯、可恢复的原生 Codex 新任务，也可以用显式双父解析处理分叉。版本锁定的 DSH Core 写入链已通过 P16 合成环境验收，但默认 composition 和正式 profile 尚未附着该 Gateway，所以日常运行仍保持写入关闭；原生双向镜像和 Dashboard 也尚未开放。

## 支持范围

- Windows 10/11
- Node.js 22.19 或更高版本
- pnpm 11.19
- Codex `0.146.0`
- 官方 DSH `0.1.1-rc.2`

## 安装

```powershell
git clone <repository-url> dsh-session-maintenance
cd dsh-session-maintenance
pnpm bootstrap
pnpm check
```

所有运行状态默认位于当前目录的 `.dsh-session-maintenance`；也可以在每条命令前用 `--state-root <目录>` 指定独立状态目录。

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

启动本地 API：

```powershell
dsh-session-maint serve --host 127.0.0.1 --port 0 --json
```

连接信息写入状态目录的 `connection.json`。API 只绑定 `127.0.0.1`，除 health 外均要求其中的 bearer token。

## 安全边界

- `instance add` 和管理员使用的 `codex-target add` 是仅有的路径登记入口；平台根、cwd 和 workspace roots 都会解析 realpath。普通 API/MCP 只接受 ID。
- `scan` 只读取平台数据；结果中的 `platformWrites` 固定为 0。
- 标题相同不会自动合并会话，只生成低置信候选。
- DSH `apply` 和 `restore` 在未显式附着已验收 Core Gateway 的默认 composition 中返回 `CAPABILITY_NOT_AVAILABLE`。
- Codex 延续只调用 app-server 创建新任务，不修改 Codex rollout、索引或 SQLite。
- 不要把 `connection.json` 提交到 Git 或发给其他人。

## 验证

```powershell
pnpm verify:clean
pnpm test:phase1
pnpm test:phase3
pnpm assert:portable
```

详细证据见 `docs/validation/phase-1-validation.md` 和 `docs/validation/phase-3-validation.md`。
