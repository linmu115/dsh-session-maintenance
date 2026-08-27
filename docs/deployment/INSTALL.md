# 安装

## 前提

- Windows 10/11、Node.js 22.19 或更高版本；
- 官方 DeepSeek Harness `0.1.1-rc.2`；
- 一个调用方选定的官方 DSH profile，例如 `web`；
- 构建产物 `dsh-session-maintenance-engine-0.1.0.tgz` 与 `dsh-session-maintenance-0.1.0.tgz`。

不需要 EAC、`web-desktop`、旧 Codex 同步插件或源码工作树。

## 1. 校验并解压 Engine

先对照 `phase2-manifest.json` 校验两个 tgz 的 SHA-256。将 Engine 包解压到用户选择的固定目录。包内包含：

- `engine/dsh-session-maint.mjs`；
- `dashboard/`；
- `Start-Session-Maintenance.cmd`。

双击启动脚本默认把状态写入 `%LOCALAPPDATA%\DSH-Session-Maintenance`。首次启动前也可以设置 `DSM_STATE_ROOT` 选择其他持久目录。

如要让 Engine 写入官方 DSH，在启动脚本后附加：

```text
--dsh-gateway dsh-web=http://127.0.0.1:3080
```

这里的 `dsh-web` 必须和下一步登记的 DSH 实例 ID 一致；端口必须是该官方 DSH 实例的 loopback 地址。

## 2. 登记平台实例

使用包内 Engine：

```powershell
node .\engine\dsh-session-maint.mjs --state-root "$env:LOCALAPPDATA\DSH-Session-Maintenance" init --json

node .\engine\dsh-session-maint.mjs --state-root "$env:LOCALAPPDATA\DSH-Session-Maintenance" instance add `
  --id dsh-web --platform dsh --root "<DSH_HOME>" --platform-version 0.1.1-rc.2 --json
```

需要读取 Codex 会话时，再登记 Codex 实例；路径只在这类可信 CLI 登记命令中出现，普通看板和插件操作只使用 ID。

## 3. 安装 DSH 插件

先让当前终端指向官方 DSH，再使用官方插件管理命令：

```powershell
$env:DSH_HOME = "<DSH_HOME>"
$env:DSH_INSTALL_ROOT = "<DeepSeek-Harness安装目录>"
$dshBin = Join-Path $env:DSH_INSTALL_ROOT "runtime-0.1.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $dshBin plugin --profile web add "<产物目录>\dsh-session-maintenance-0.1.0.tgz"
```

官方命令会把包登记为 profile 顶层依赖，并把它加入 `dsh.profile.bundles`。不要手工复制到全局 `node_modules`。

## 4. 把 DSH host 连接到 Engine

Engine 启动后会在状态目录写入受保护的 `connection.json`。启动 DSH 的同一可信脚本或终端需要设置：

```powershell
$env:DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY = "$env:LOCALAPPDATA\DSH-Session-Maintenance\connection.json"
node $dshBin --profile web --host 127.0.0.1 --port 3080 --no-open
```

不要把 token 复制到 DSH 设置、浏览器、本项目 README 或 Git。Engine 每次启动都会轮换 capability；插件 host 按描述符更新时间自动重读。

## 5. 首次验收

1. 打开官方 DSH 页面，确认没有 “Failed to load plugins”。
2. 页面出现“会话维护”入口；会话右键出现扫描、版本图、比较和 Checkpoint 等操作。
3. 点击“扫描当前会话”，确认返回 job ID 或明确的离线提示。
4. 打开独立看板，确认版本图、计划和 Checkpoint 页面可访问。
5. 在任何写入前先建立 Checkpoint；需要人工复核的计划不会从菜单直接执行。

自动化验收命令及证据见 `docs/validation/phase-2-acceptance.md`。
