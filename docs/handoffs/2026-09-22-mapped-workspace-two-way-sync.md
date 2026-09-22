# 交接：映射工作区的双向同步（2026-09-22）

> 本文写给接手的开发方。它是**点快照**：仓库内 `docs/handoffs/2026-09-22-mapped-workspace-two-way-sync.md` 是权威版本，诊断目录里的同名副本只是同一时刻的拷贝。
> 上一轮背景见 `docs/handoffs/2026-09-20-maintenance-and-independent-acceptance.md` 与 `docs/handoffs/2026-09-21-engine-acceptance-site.md`。

## 0. 一句话现状

| 要求 | 状态 |
| --- | --- |
| 引擎启动那一刻：以引擎（真源）为准 | ✅ 已实现 + 真机验证（`startup.alignment`） |
| 引擎运行期间：以我（实例）为准 | ⚠️ 代码已实现（页面半边 + 宿主半边），但被上游缺失的 **platform binding** 阻塞 → **真机不生效** |
| 两侧范围都只限勾选的同步工作区 | ✅ 引擎侧范围门禁 + 真机验证（非勾选会话 `not-synced`、实例树里 0 文件） |
| 其它非绑定工作区不受影响 | ✅ 同上；但"实例里存在非绑定工作区"的场景本机测不了（实例当前没有非绑定工作区） |
| 引擎侧自动登记映射工作区（不再人工） | ✅ 真机验证（宿主自己改写 `storages/workspace.json`） |
| 真源→实例的**归档态** | ❌ 无写入口（宿主只有 `archiveSession`，全运行时无 `unarchive`） |
| 派生会话物化（4+1 个） | ❌ 未修（用户已批准方案，见 §5 P1） |

**当前唯一的硬阻塞**：引擎从未为 DSH 侧会话登记 `platform_bindings`，导致实例→真源的任何回传在范围门禁处被判"未映射"而丢弃（§4 有完整证据）。

## 1. 环境与运行态（精确值，交接时）

- 工作树：`D:\AI\DeepSeekHarness-Plugin\worktrees\session-context-graph-20260913\dsh-session-maintenance`，分支 `codex/image-startup-recovery-20260917`，HEAD `4bce1ec`。
- 未提交内容：`docs/deployment/launcher-hook.md`、`docs/handoffs/2026-09-20-*.md`、`docs/issues/2026-09-20-managed-plugin-composition.md`（修改）、`docs/handoffs/2026-09-21-engine-acceptance-site.md`（未跟踪）、`plugins/dsh-session-maintenance/maintenance-adapter.json`（构建产物）。
- 实例：`i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5`；profile 目录 `web`；Maintenance 身份 `web-i27c4`。
  - DSH Home：`C:\Users\19717\AppData\Roaming\in.dsh-plug.dsh-launcher\homes\0.1.5-rc.2 测试`
  - 会话根：`<home>\sessions`（项目目录 = 适配器 `projectKey(cwd)`）
  - 工作区注册表（宿主权威）：`<home>\storages\workspace.json`（unit `workspace` v2）
  - 实例日志：`%APPDATA%\in.dsh-plug.dsh-launcher\logs\i-27c4d5a7-….log`；启动器日志 `…\logs\latest.log`
- 引擎状态根：`C:\Users\19717\AppData\Local\DSH-Session-Maintenance`
  - DB：`metadata.projects-20260906-0-1-19.sqlite`（约 806 MB；**只读**访问用 `node:sqlite` 的 `{ readOnly: true }`）
  - 连接描述：`connection.json`（port/token/pid）；owner：`maintenance-writer.json`
  - 回写日志：`logs\instance-write-back.jsonl`；生命周期：`logs\engine-lifecycle\<pid>.jsonl`
- 引擎：`D:\AI\DeepSeekHarness-Plugin\artifacts\architecture-upgrade-20260920\engine-0.1.42-rc2.70-dir-connect\engine\dsh-session-maint.mjs`（交接时 pid 36792 / port 36264）。
- 插件：`dsh-session-maintenance@0.2.26-rc2.44` 已装入 profile；`profiles\web\package.json` 依赖行指向 rc2.70 的 tgz；收据 `maintenance-runtime-attestation.json`（`engineVersion=0.1.42-rc2.70`，23/23 哈希自检通过）。
- 制品目录：`D:\AI\DeepSeekHarness-Plugin\artifacts\architecture-upgrade-20260920\`（每版一个目录；`release-sources.json` 是打包输入）。
- 勾选范围：97 个桶里勾 **2** 个，`includeUnassigned=false`，policy `revision=6`
  - `workspace-runtime-7c82a502ea170c76cb296a1645b1900c`（DeepSeekDemoWorkplace）→ `D:\DeepSeekDemoWorkplace`（**复用实例自己的工作区**；宿主 workspace id `1f891ec5-…`，46 成员）
  - `workspace_af28823bbf61b6cf46eaee0a`（计算机四大）→ `D:\DSHworkplace\计算机四大`（宿主 workspace id `52fb5b7b-…`，12 成员）
- 实例会话树：62 个会话目录 = 46（DeepSeekDemoWorkplace）+ 12（DSHworkplace\计算机四大）+ 4（遗留旧目录），**0 重复**。

## 2. 用户口径（这是需求，不是设计自由）

1. **时机**：引擎启动那一刻以引擎（真源）为准；引擎运行期间以实例为准。
2. **范围**：两侧都只限实例**勾选的同步工作区**；其它非绑定工作区不受影响（两个方向都不许碰）。
3. **权限**：实例的启停由用户负责；引擎可由开发方自行启停。
4. **数据**：真源数据不得删除/迁移/重建；宿主的版本化存储不得绕过其 API 直接改写。
5. **流程**：本地提交、不 push；安装必须原地进行并留备份 + 逐文件哈希核验；改动前先汇报，用户逐项批准。
6. **当前门槛**：用户明确说过"这一点（双向同步 + 非绑定不受影响）没做好，其它的啥都不要干"。

## 3. 本次会话已完成（提交与落点）

| 提交 | 内容 | 主要文件 |
| --- | --- | --- |
| `e176760` | 跨项目重复会话：写前观察整棵树、`relocate` 动作、回读校验后备份并退掉旧副本、清理空目录；0 字节占位判为"内容缺失"要重写；同名工作区复用实例自己的路径；映射规则收敛为 `mapWorkspaceFolders` 单一实现 | `apps/engine/src/native-session-observation.ts`（新）、`native-session-overwrite.ts`、`instance-session-writeback.ts`、`instance-write-back.ts`、`packages/contracts/src/instance-workspace-policy.ts` |
| `006a0c8` | `workspace-folders` 分支被 `safeId(input.sessionId)` 挡住 → 宿主自动登记从未生效；把会话 ID 校验移到该分支之后 | `plugins/dsh-session-maintenance/src/engine-proxy.ts`、`test/proxy.test.ts` |
| `51132ca` | 引擎启动即对齐（`InstanceWorkspaceService.alignRegisteredInstances()` + `cli serve` 触发 + 生命周期记录）；宿主侧运行期回传 `HostSessionSync`（页面无关） | `apps/engine/src/instance-workspace-service.ts`、`instance-workspace-runtime.ts`、`cli.ts`；`plugins/dsh-session-maintenance/src/host-session-sync.ts`（新）、`src/index.ts` |
| `4bce1ec` | 启动对齐的生命周期记录带上首个失败原因（只记数量无法诊断） | `apps/engine/src/cli.ts` |

每项都有配套测试；受影响范围 **234 项通过**；`tsc --noEmit` 干净（`apps/engine`、`packages/contracts`、`plugins/dsh-session-maintenance`）。

## 4. 真机验收结论（本轮，含证据）

### ✅ 1) 自动登记（宿主自己建工作区 + 归属会话）
- `storages\workspace.json` 在实例就绪（11:59:30）后 **11:59:33** 被改写；
- `DeepSeekDemoWorkplace` 成员 11 → **46**（= 该目录下全部会话：maintenance×3 + 其他×32 + session×11）；
- `计算机四大` 12 成员、`updatedAt` 仍是 10:51（**幂等，未重复写**）。
- 结论：不再需要人工登记（此前外部模型是手工用宿主 API 登记的）。

### ✅ 2) 引擎启动即按真源对齐
- `logs\engine-lifecycle\36792.jsonl`：
  `startup.alignment  i-27c4d5a7… written=0 unchanged=19 skipped=0 failures=1 first=logical-derived:f82f1368…: format v2 contains unknown event type "context/operation" at seq 424`
- 同时 `logs\instance-write-back.jsonl` 仍 31 行、mtime 09:23 → **没有重写任何文件**。
- 说明：启动对齐走的是同一套范围受限回写；`failures=1` 是派生会话那个已知问题。

### ✅ 3) 非绑定工作区不受影响
- 97 桶只勾 2（`selected=true: 2 / false: 95`）；
- 非勾选桶抽样 4 个会话：`availability = not-synced`，实例 `sessions` 树里**没有**它们的目录；
- 勾选桶抽样 3 个：`offline`（= 已映射）且都在实例树里；
- 实例树 62 个会话、0 重复，与"只物化了这 2 个桶 + 遗留旧目录"一致。

### ❌ 4) 实例→真源（归档）——被上游缺失的绑定阻塞
用户已在实例侧归档 `dsh-maintenance_bHNfNzQ3ZWM4ZTJkMWIwODEzMzQ1OTdkYjMw`（= 逻辑会话 `ls_747ec8e2d1b081334597db30`）：
- 宿主如实记录：`workspace.json` **12:04:29**，`archivedSessionIds` 增加该 id；
- **真源未变**：该逻辑会话 `archived_at` 仍是 `2026-09-08T10:22:31.904Z`；
- （本次测试有混淆项：该会话在真源里本就已归档，所以即使推送成功也看不出变化。为此改用只读探针。）

**只读探针（决定性）**——直接调用插件代理所用的同一接口 `POST /v1/session-resolution`：

| 原生会话 ID | 引擎答复 |
| --- | --- |
| `dsh-maintenance_bHNfNzQ3ZWM4…` | 404 `SESSION_NOT_MAPPED` |
| `dsh-maintenance_bHNfMjQ3MzFi…` | 404 `SESSION_NOT_MAPPED` |
| `session-1f0a7c93…`（宿主自带、已归档） | 404 `SESSION_NOT_MAPPED` |
| `session-878322ac…`（用户当前会话） | 404 `SESSION_NOT_MAPPED` |

**根因链**：
1. 解析实现：`SessionMaintenanceEngine.resolvePlatformSession` → `repository.findBinding({platform, instanceId, sessionId})` → 查 `platform_bindings`。
2. 表实况：**502 行全部是 `platform='codex', instance_id='codex-main'`**；`platform='dsh'` **0 行**；`session_aliases` 也是 **0 行**。
3. 唯一写入者：Codex 续写方向（`packages/continuation-engine/src/service.ts:463`，以及 `packages/session-store/src/canonical-engine-store.ts` 的 Codex authority 分支）。**没有任何 DSH 侧写入者**——引擎把会话写进实例（回写）时、把实例原生会话镜像成 `logical-dsh-*`（join）时都没有登记绑定。
4. 后果：`session-mapped`（引擎代理解析 native→logical）恒为 false → 客户端半边与新增的宿主半边都按"未映射"跳过、谁都不推。此前只有 prepared run 里的 run 作用域解析（`/v1/projection-runs/<run>/sessions/<native>/identity`）能用——所以这条方向"看起来实现过、其实普通启动下从来没生效"。

### ❌ 5) 真源→实例的归档态
- 宿主 API 只有 `archiveSession`（往 `archivedSessionIds` 追加），**整个 rc.2 运行时搜不到 `unarchive`**；`archivedSessionIds` 没有任何移除入口 → 归档是**单向门**（实例侧归档后不可回退）。
- 引擎侧也不写宿主版本化存储（`apps/engine/src/native-session-overwrite.ts` 的注释里明确标注 deferred）。
- 现成实证：真源「计算机四大」桶 17 个会话里 5 个是归档态（4 个 `logical-derived:*` + `ls_747ec8…`），实例侧 `archivedSessionIds` 里一个都没有（只有 3 个宿主自带 id）。

## 5. 待办（按优先级，含落点与验收）

### P0-1 登记 DSH 侧 platform binding（解阻塞）
- 回写成功写出一个会话时，登记 `{ platform:'dsh', instanceId, sessionId: nativeSessionId } → logicalSessionId`；镜像方向（`logical-dsh-<sha256(instanceId\0native)>`，见 `apps/engine/src/workspace-session-mapping.ts:62`）建立时同样登记。
- 现成 API：`packages/session-store/src/repository.ts:821 bindPlatformSession(input: PlatformBinding)`（幂等，且有 IDENTITY_CONFLICT 保护）；参考写入样例：`packages/continuation-engine/src/service.ts:445-464`。
- 落点建议：`apps/engine/src/instance-session-writeback.ts`（apply 成功之后）、`apps/engine/src/instance-write-back.ts`（拿到 `written` 明细处）；镜像方向在 join/mirror 的建立处。
- 验收：重启实例后 `POST /v1/session-resolution {platform:'dsh',instanceId,sessionId:'dsh-maintenance_<b64(logicalId)>'}` 返回 200 且 `logicalSessionId` 正确。

### P0-2 重做归档验收（必须换会话）
- **必须选真源侧未归档的会话**，例如 `ls_24731bf68593ab10bc5ff590`（对应原生 id `dsh-maintenance_bHNfMjQzFiZjY4NTkzYWIxMGJjNWZmNTkw` 的 base64 形态以实际目录名为准）；否则推送成功也看不出变化。
- 记录时间差可粗略归因：<1 s 多为页面半边；落在 30 s 轮询点上多为宿主半边（两者都推时后者是幂等空操作）。
- 慎用：实例侧归档**不可回退**，请用户指定不介意的会话。

### P1 派生会话物化（用户已批准，两步 + 一个新根因）
- (a) 写回侧稠密化：进 `materializeV3` 前把该会话事件按顺序重编号（`sequence = i`、`rawPayload.seq = i`）。原因：`packages/adapter-dsh-0-1-5/src/materialize.ts:19/26` 要求 `rawPayload.seq === i`，最终 `validateV3` 走 DSH 的 released-v2 校验（`dsh-session-format-v1-to-v2/lib/index.js:92`）。
- (b) 真源侧根因：`packages/canonical-session-engine/src/dsh-append.ts:106` 的 `if (first > last) return appended;` 对派生批次无效（派生批次的编号来自父会话原生文件，与子会话 `base.last` 无关），应无条件平移到 `last+1` 起，并同步平移 `rawPayload.seq`（该函数注释里"raw event offsets remain untouched"正是问题所在）。只影响新派生，不改既有数据。
- (c) **新发现、同批处理**：`logical-derived:f82f136808fa17c0f2f4142ffb4893123c071e507af893fa0c8166421` 报 `format v2 contains unknown event type "context/operation" at seq 424` —— `context/operation` 是 DSH 与 annotation 插件认识的事件类型，但引擎里 pinned 的格式词表不认识（`mode === "current"` 且既不在 disposition 表也不在 installed catalog → 拒绝）。可选修法：把扩展事件类型词汇同步给引擎，或对这类行标 `ignorable: true`（格式包明确支持未知类型带 `ignorable` 放行）。
- 遗留：旧目录 `--C-Users-19717-OneDrive-…计算机四大--` 里还有 **4 个派生会话**（native id 见 §7），引擎 marker 指向旧路径 → 被判 `unchanged`，**永远不会搬到映射目录**；属于同一批工作的延伸。

### P1 插件日志可见性
- `ctx.logger.info` 在本部署**落不到任何日志文件**（实例日志、启动器日志都没有插件输出），所以宿主侧两个模块的成功/失败目前是不可观测的。
- 建议：`plugins/dsh-session-maintenance/src/mapped-workspaces.ts` 与 `host-session-sync.ts` 的 `report` 改用 `console.info`（实例日志 = 实例进程 stdout）。

### P2 门禁要能区分"缺陷"与"策略"
- 现在"解析不出逻辑会话（缺陷）"和"不在勾选范围（策略）"都表现为 `mapped=false` → 被静默跳过。建议让 `session-mapped` 返回可区分的码，并让插件把它计入可见报告。

### P2 真源→实例的归档方向
- 宿主有 `archiveSession`，插件可做**单向**（真源归档 → 实例归档）；反向（取消归档）宿主没有 API，做不到。

### P2 实例追加的运行设置行会被覆盖
- 那 12 个导入会话在真源里**只有对话事件**（如 `ls_24731bf…`：112 行 user/assistant/tool/reasoning，`rawPayload` 全空），**没有** `permission/preset`、`sandbox/mode`、`approval/policy`、`session/end-seed`（这 4 类由 DSH 核心包 `dsh-permission-presets`/`dsh-sandbox-policy`/`dsh-compaction` 写，宿主采用会话时追加了 42 行）。
- 引擎哪天因真源内容变化重写这些会话，这 42 行会丢。两条路：回写改成"以实例文件为底、叠加真源新事件"，或让插件把设置行也镜像进真源。

## 6. 操作手册（照抄即可）

### 引擎启停（开发方可做；**实例由用户启停**）
```powershell
$s = "$env:LOCALAPPDATA\DSH-Session-Maintenance"
$c = Get-Content "$s\connection.json" -Raw | ConvertFrom-Json      # 记下 pid
if (-not (Get-Process -Id $c.pid -ErrorAction SilentlyContinue)) { throw 'recorded pid not running' }
taskkill /F /PID $c.pid
Start-Sleep -Seconds 2
if (Get-Process -Id $c.pid -ErrorAction SilentlyContinue) { throw 'still alive' }
$new = 'D:\AI\DeepSeekHarness-Plugin\artifacts\architecture-upgrade-20260920\engine-0.1.42-rc2.70-dir-connect'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Process -FilePath 'D:\nodejs\node.exe' -ArgumentList @(
  "$new\engine\dsh-session-maint.mjs", '--state-root', $s, 'serve', '--host','127.0.0.1','--port','0',
  '--dashboard-root',"$new\dashboard",'--recover-dead-owner'
) -RedirectStandardOutput "$s\logs\manual-start-$stamp.stdout.log" -RedirectStandardError "$s\logs\manual-start-$stamp.stderr.log" -WindowStyle Hidden
```
- **必须带 `--recover-dead-owner`**，否则启动即 `WRITER_OWNER_UNKNOWN: unowned Engine connection` 退出。
- 启动后看 `logs\engine-lifecycle\<新pid>.jsonl`：应有 `startup.begin` →（可选 `owner.recovered`）→ `startup.ready` → `startup.alignment`。

### 打包与安装（原地，留备份 + 哈希核验）
```powershell
# 1) 构建插件 lib（引擎 bundle 由打包脚本直接从源码构建）
node plugins/dsh-session-maintenance/scripts/build.mjs
# 2) 打包到全新目录（脚本拒绝覆盖已存在目录）
node scripts/package-independent-components.mjs --out <新制品目录> --sources artifacts\architecture-upgrade-20260920\release-sources.json
# 3) 安装插件：备份 node_modules\dsh-session-maintenance + profile package.json + 两份收据 →
#    解 tgz 覆盖 → 逐文件 SHA-256 对比 → 改 profile package.json 的依赖行为新 tgz
# 4) 重生成收据（先把旧收据移走，脚本拒绝覆盖）
node "<profile>\node_modules\dsh-session-maintenance\lib\verify-installation.mjs" `
  --config <standalone-instance json> --engine <新 engine bundle> --engine-version <ver> `
  --out-dir "<profile>" --profile-dir web
```
- 版本要同步 bump：`apps/engine/package.json`、`plugins/dsh-session-maintenance/package.json`，以及 `plugins/dsh-session-maintenance/test/package-compatibility.test.ts` 里的版本钉。

### 测试与类型
```powershell
# 必须在工作树目录下跑（否则 vitest 报 No test files found）
node_modules\.bin\vitest.cmd run plugins/dsh-session-maintenance/test apps/engine/test/instance-workspace-service.test.ts ...
node_modules\.bin\tsc.cmd -p apps/engine/tsconfig.json --noEmit
```
- 既有失败（**非本会话引入**）：`conversation-topology-repair` ×3、`codex-project-mapping-offline` ×1、`extension-data.test.ts:119`、`server-readiness` ×1、`engine-startup.test.ts`、`user-request-index-service`（EPERM，偶发）。

### 只读取证
```powershell
# 引擎 HTTP（token 在 connection.json）
GET  /v1/health
GET  /v1/instances/<id>/workspace-sync
GET  /v1/instances/<id>/workspace-scope?profileId=web-i27c4
GET  /v1/instances/<id>/workspace-folders
GET  /v1/instances/<id>/sessions/<logicalId>/availability?profileId=web-i27c4
POST /v1/session-resolution   { platform:'dsh', instanceId, sessionId }
```
- DB 只读：`new DatabaseSync(path, { readOnly: true })`（`node:sqlite`）。关键表：`logical_sessions`、`canonical_events(id, logical_session_id, sequence, kind, content_digest, event_json)`、`workspace_memberships`、`platform_bindings`、`session_versions(body_object)`；对象存储：`<stateRoot>\objects\sha256\<前2位>\<其余>.zst`。

## 7. 证据与现场文件

- 本会话报告：`C:\Users\19717\OneDrive\文档\ChatGPT\dsh\diagnostics\mapped-workspace-defect-20260922-1030\报告.md`（+ 本文副本）
- 上一轮的启动失败溯源与恢复：`…\diagnostics\startup-recovery-20260922-0930\`（`报告.md`、`plan.json`、`backup-sessions\`、`quarantined-new-copies\`）
- 外部模型的手工迁移与登记：`…\mapped-workspace-defect-20260922-1030\migration\`（`migration-plan.json` 含逐文件 SHA-256、`offline-verification.json`、`registration-receipt.json`、`online-verification.json`、`backup-sessions\`、`backup-config\`、`backup-markers\`）
- 安装备份：`D:\AI\DeepSeekHarness-Plugin\artifacts\architecture-upgrade-20260920\install-backups\<时间戳>\`
- 收据历史：`…\artifacts\architecture-upgrade-20260920\receipt-regen-20260921\`
- 遗留旧目录 4 个派生会话（native id 前缀 `dsh-maintenance_bG9naWNhbC1kZXJpdmVk…`）：
  `…OjcyOTIxZDU2NDc5MjAzMmEwYTViZWM4ZDJhYmQ2MzUzMTg4YThkOTU1OWRmNmNkYmNmZTQ4Y2FkNw`、
  `…OjhkOTYzODNiNTQ1NWY0Y2ExYTFiNDNlZTc0NzY1OGVkZDA0YmQ3Y2NhN2JiZjU4NTA4NWJkYWQ1MQ`、
  `…OjUxMTYwMzA3ZmYyOWMzMzVmM2IzZGZhMzEwMWUxZjY4MzRhY2IyNWY5NjFkZDgxMjRlODEwMTZjZA`、
  `…OmVhYWNhZGI3MzA0YjBlMTkwZWVlODU3ZDBiZDFkOWJiMmU3MzI0NjRlMjMyY2UzZWQ5MjYxOTI2NQ`

## 8. 已知陷阱（本会话踩过的，请直接绕开）

1. **宿主按目录判重**：同一 session id 出现在两个项目目录 → 实例启动失败（`duplicate JSONL session id ... appears in multiple project directories`）；而 **0 字节文件会被跳过**（不算内容）——"能启动"不代表没问题。
2. **`onFeedback?.(await report(...))` 陷阱**：可选调用短路时参数**完全不求值**，副作用被静默跳过却计为成功。副作用必须写成独立语句。
3. **vitest 要在工作树目录下跑**（`workdir`），否则报 `No test files found`。
4. **PowerShell 里 `node -e` 极易被引号/中文搞坏**：复杂脚本落到 `$env:TEMP\*.mjs` 再 `node <file>`。
5. **PowerShell 7 的 `Invoke-WebRequest` 失败时异常对象是 `HttpResponseMessage`**（没有 `GetResponseStream`）→ 用 `node` + `fetch` 读错误体。
6. **路径含空格**时不要用 `require('C:/…%20测试/…')` 这类拼法（会 `MODULE_NOT_FOUND`）；用 `fs.readFileSync`/`join` 或 `--out-dir` 参数传目录。
7. **git worktree 的 `.git` 是文件**，不能往里写临时文件；提交信息用外部文件 + `git commit -F`。
8. **打包脚本拒绝覆盖已存在目录**；版本号要 bump，并同步 `package-compatibility.test.ts` 的版本钉。
9. **pnpm 不在 PATH**（只有 `D:\nodejs\corepack.cmd`）；用 `node_modules\.bin\*`。
10. **`ctx.logger.info` 在本部署没有落盘 sink**（见 §5 P1）。
11. **实例侧归档不可回退**（无 `unarchive`）；任何会让实例侧状态永久改变的验收动作，先让用户指定对象。
12. **引擎启动必须 `--recover-dead-owner`**；强杀引擎后 `maintenance-writer.json` 会残留，需先证明 pid 已死再恢复。

## 9. 建议的接手顺序

1. 读 §2 口径与 §4 结论，确认与用户对齐（尤其是"P0-1 才能解锁双向同步"这一点）。
2. 做 P0-1（登记 binding）+ P0-2（重做归档验收，换会话）——这是用户当前唯一在意的门槛。
3. 门槛通过后，再按 P1 批次做派生会话物化（含新发现的 `context/operation`）、插件日志可见性；一并重启一次。
4. 每次改动：先汇报 → 用户批准 → 改代码 + 测试 → 打包/安装（留备份与哈希）→ 交用户重启实例 → 取证验收 → 本地提交（不 push）。
