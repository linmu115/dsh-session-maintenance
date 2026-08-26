# DSH Session Maintenance

一个以不可变版本图管理 Codex 与官方 DeepSeek Harness 会话的本地维护引擎。

当前 Phase 1 是严格只读版本：可以登记实例、扫描会话、查看版本图和差异、生成 dry-run 计划，并通过认证的本地 API 使用这些能力。它不会写入 Codex/DSH 会话，也不提供 apply、restore、双向镜像或 Dashboard。

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

- `instance add` 是唯一接受平台路径的入口，登记前会解析 realpath 并验证版本契约。
- `scan` 只读取平台数据；结果中的 `platformWrites` 固定为 0。
- 标题相同不会自动合并会话，只生成低置信候选。
- `apply` 和 `restore` 在 Phase 1 固定返回 `CAPABILITY_NOT_AVAILABLE`。
- 不要把 `connection.json` 提交到 Git 或发给其他人。

## 验证

```powershell
pnpm verify:clean
pnpm test:phase1
pnpm assert:portable
```

详细证据见 `docs/validation/phase-1-validation.md`。
