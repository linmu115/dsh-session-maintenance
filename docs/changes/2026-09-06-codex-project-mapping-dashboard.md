# Codex 项目映射 Dashboard 与客户端变更报告

日期：2026-09-06

## 行为

同步页主界面现在按 Codex 项目会话文件夹显示完整映射目录，每项可以勾选，支持名称和项目标识搜索。相同名称和相同根路径的项目使用来源实例与项目标识区分，保存时提交共享契约的稳定项目 key。根路径仅放在项目详情中，不作为会话归属依据。

页面分别展示当前活跃名单和最新已保存名单、各自版本以及下次启动生效状态。未配置与明确保存空名单有不同文案；空名单表示不映射任何项目。主要按钮为“保存为最新映射名单”。取消更改恢复当前读取的已保存名单；刷新目录明确取消未保存更改，重新读取配置。搜索不改变选择。

说明所选项目现有与未来新增本地 Codex 会话都会纳入映射；混合项目只纳入本地会话。明确提示未选项目会话将在下次启动时从 Maintenance 移除并保留恢复点，Codex 源会话不会删除。

观察器状态和上次错误独立显示，观察器错误不妨碍保存下一次启动配置。保存冲突保留当前勾选，并提示刷新核对；未提供 API、空目录、不合格项目、目录暂不可见的已保存项目都有说明。异步请求取消后不会覆盖后续页面状态。

原有工作区原生回写 UI 保留在默认折叠高级区，仅展开时加载，不构成项目映射功能门槛。DashboardApi 继续通过既有 WorkspaceSyncApi 接口扩展获得新方法，app.tsx 无需修改。

## 客户端

新增 getCodexProjectMapping 和 saveCodexProjectMapping 方法，分别请求 GET/PATCH /v1/codex-project-mapping。请求体与响应采用 contracts 的共享 Zod 契约校验，支持 AbortSignal，沿用 cookie/CSRF 和 bearer 两种既有传输机制。

## 验证

- apps/dashboard/test/codex-project-mapping.test.tsx：7 项合成交互测试。
- packages/local-api-client/test/codex-project-mapping.test.ts：3 项传输、验证、冲突测试。
- apps/dashboard/test/reading-dashboard.test.tsx：15 项既有交互回归测试，旧工作区测试直接测试保留的 NativeWorkspaceSyncPage。
- Dashboard 和 local-api-client 类型检查通过。

测试只使用合成内存 fixtures 和拦截的传输。测试运行器最初在沙盒中因 esbuild 子进程 spawn EPERM 无法启动，随后以所需子进程权限执行测试成功。本报告不声明实机运行导入或重启激活已完成；这些由 Engine 集成验证覆盖。

按任务要求未提交 commit，未修改 README/changelog、adapter 或 contracts。后续独立审查发现的手动恢复问题按授权补充修复如下。


## 补充：手动恢复后所属项目可见性

独立审查发现：映射清理会退休无活跃会话的项目，既有单会话恢复仅复活会话，导致恢复后的会话不再列在“最近删除”，却仍因项目被隐藏而不出现在主目录。

在 apps/engine/src/session-maintenance-commands.ts 的 restoreSession 同一事务内，根据该会话现有 project_memberships 的精确 project_id 复活对应 logical_project。此操作不按项目名称、根路径或 workspace 推断分组，不改变映射政策，也不会复活同名其他项目。若项目复活失败，会话和 tombstone 恢复共同回滚。

用户手动恢复后会话及其原有项目立即可见；下次启动仍按当前映射名单重新清理范围外会话，并建立新的恢复点。

新增独立 apps/engine/test/codex-project-mapping-manual-restore.test.ts 的 3 项合成测试，验证：

- 两个项目名称及根路径相同，手动恢复只复活精确所属项目及会话；原始会话 head 和 Codex 源文件保持不变。
- 下次启动按未改变的空名单重新清理，并生成新的恢复点。
- 注入项目复活失败时，会话、tombstone 与目录状态共同回滚。

新增 3 项及既有 session-maintenance-commands.test.ts 8 项测试全部通过（11/11）。

## 补充：保留策略兼容 schema 21

完整回归暴露引用读取及静态 SQLite 恢复点核验各有一个显式版本白名单，仅包含 16、17、19、20。新增项目映射迁移把数据库版本提升为 21，因此安全检查将正常数据库误判为未知格式，继而阻塞保留策略预览、缓存治理及 flat 恢复点注册。

生产改动严格限于 packages/session-store/src/retention-repository.ts 和 retention-registration.ts：两个白名单各追加已知版本 21。仍拒绝未支持的低版本、历史缺口版本及未来版本，保留 quick_check、foreign_key_check、清单摘要和对象内容核验。未使用宽泛版本区间，也未改 migration 或以 IF NOT EXISTS 掩盖损坏。

新增 packages/session-store/test/retention-schema21.test.ts 共 6 项测试：schema21 引用与flat恢复点正常；15、18、22、999仍同时被引用读取和candidate核验拒绝；schema21新增removals表中的损坏外键仍被拒绝。所有静态源核验后原始字节保持不变。session-store类型检查通过。

受影响 retention suites 加 adapter-evidence 回归共 10 文件、50 项；第一轮48项通过，仅flat两条因5秒默认上限超时，已按仓库既有15秒测试上限单独重跑flat文件。retention-migration测试由另一代理独立负责，未在本子任务修改。
flat文件单独重跑6/6通过（最慢4.95秒）；本轮10个文件的50个不同测试均已有通过结果，没有发现剩余功能失败。
