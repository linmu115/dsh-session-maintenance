# Codex 项目目录与限定读取

新增 `readCodexDesktopProjectDirectory(instance, { fixtureGuard? })`，只读取桌面项目元数据和 SQLite 会话身份，不读取 rollout 正文，也不按 cwd、项目根路径或名称推断成员关系。旧 `readCodexProjectCatalog` / `resolveCodexProject` 保持原有行为，供已有迁移调用使用。

返回项目稳定 ID、显示名、server project ID、根目录、来源、`local/mixed/unknown` 分类、真实本地成员 ID；另返回按会话 ID 索引的显式归属、迁移状态、问题、`safeForSelection` 和内容指纹。零成员项目保留。`mixed` 表示桌面使用 ChatGPT 链接项目身份，其 `memberThreadIds` 仍只包含真实本地 Codex 行，不承诺云聊天可读。

目录合并使用 `local-projects`、`projects` / `project_roots` 与当前 Codex Home 对应的 `app-server-project-id-by-legacy-project-id-by-host`，同名不同 ID 保持独立。迁移未完成时，`thread-project-assignments[threadId]` 优先，允许归一化为同一 ID 的 SQLite 对应值；显式值与 SQLite 归属冲突则不输出该条归属并标记不安全。迁移完成后只信任 `threads.project_id`，NULL 不再回退旧桌面归属。缺少、无法读取、异常或未知的目录/本地成员数据，以及读取过程中桌面文件变化，均使 `safeForSelection=false`。调用者必须在保存选择、删除或清理前拒绝不安全快照。

`CodexReadAdapterOptions.threadIds` 是复制后的闭集范围；空集合不读取或检查任何 rollout 文件。限定模式的 probe 只验证 SQLite 结构，正文格式检查由选中成员的 observe 完成；list 在解析真实路径和 stat 前过滤，observe 也拒绝范围外成员。非限定模式保留原有 probe 和状态说明。

新增 `readCodexSessionChangeFingerprint`，仅为一个明确选中的本地会话读取元数据和 rollout 的路径、大小及高精度时间/文件身份，返回变化指纹；`readCodexSessionChangeStamp` 从同一次元数据读取提供完整指纹、排除标题/显示名/更新时间后的正文相关指纹与显示标题，供纯标题变化使用轻量提交路径。它不是锁定快照，也不保证下一次读取期间源不再变化，提交方仍需前后比对和重试。

验证：新增目录测试 12 项、限定读取与变化指纹测试 3 项通过；既有项目 resolver 2 项、schema 3 项通过；既有 adapter 16 项在恢复旧状态说明后重跑通过。Adapter typecheck 通过。测试使用带标记的临时合成 Home，未写真实 Codex 数据。

本机只读证据另存工作区 `.artifacts/maintenance-project-mapping-20260906/catalog-evidence.json`：指定五个项目共 32 个有本地行且 rollout 存在的显式成员。该快照不含会话正文或认证数据，是当时目录证据，不应作为持续运行时的静态白名单。
