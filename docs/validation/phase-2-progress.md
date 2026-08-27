# 第二阶段进度

## 当前状态

- P14 可恢复写事务：完成。
- P15 官方 DSH `0.1.1-rc.2` 写入 Adapter：路线 A 的 Core、Gateway、Adapter 与 P14 自动恢复链均完成。
- P16 Codex → DSH 安全快进与分支保留：路线 A 的严格门禁、验证后原子 ref 推进、幂等 apply 与分叉零写入已完成。
- P17 类型化 operation API 与持久作业：完成。
- P18 DSH 风格 Dashboard 基线：完成。
- P19 会话 GitGraph、三方差异、计划预览和 Checkpoint：完成；P20 恢复/诊断/设置待施工。

## P14 已验证能力

- schema 2 数据库一次性升级到 schema 3；更高版本继续失败关闭。
- 事务计划、SQLite 状态与 fsync JSONL 哈希链共同保存；日志/数据库分歧进入 `manual-review`。
- required backup 缺失或内容哈希变化时拒绝使用。
- 同一 DSH 根串行写入，不同根可并行；跨进程 owner lock 不会被普通写入窃取。
- 同一 plan/hash 重复 apply 返回原事务，不再次提交。
- plan 指纹过期、Adapter 契约漂移、同一根存在未解决事务时，在平台 mutation 前失败。
- commit/verify 故障触发一次 restore；restore 自身失败不会再次调用 restore。
- 显式 restore 需要五分钟、单次、操作范围绑定的 confirmation nonce。
- named checkpoint 可重开，并保护其完成事务 backup；content GC dry-run 返回每项保留或可删除原因。

## 数据边界

P14 只使用 fake write Adapter 和临时测试目录，没有读取或修改本机正式 Codex/DSH home。平台实际写入仍保持禁用，直到 P15 能从官方 DSH 服务证明可恢复的版本锁定写入契约。

## P15 契约门禁结果

- 官方 `@deepseek-ai/dsh-session-persistence@0.1.1-rc.2` 公开 `create` 与 `append`，但没有 `remove/forget/truncate/replace/restore`。
- 官方 `@deepseek-ai/dsh-workspace@0.1.1-rc.2` 只有 `archiveSession`，没有官方逆操作。
- title 修改是追加 `session/title` 事件，没有恢复旧 artifact 的逆操作。
- 因此 `create-session`、`append-events`、`update-title`、`update-archive` 与 `restore` 全部禁用，只保留无写入的 `verify` 能力描述。
- 契约已锁为 `dsh-write/0.1.1-rc.2/session-v0:2c1456d8a5a834badd6dfd603adce2cfbbae6afdd4e5413e898c78c5a0dcb8f0`；任何方法或 npm integrity 漂移都返回 `ADAPTER_INCOMPATIBLE`。
- 本机 runtime 的 `dsh-workspace/lib/index.js` 带有非官方 `dsh-desktop patch`，与 npm 包哈希不同；Maintenance 不依赖该补丁。
- 按已确认计划，P15 在 Step 1 停止，没有实现 host gateway 或 raw-file fallback，P16 暂不能开始。

## 路线 A：版本锁定 Core 扩展

- 新增独立 `@linmu/dsh-core-extension` 深模块；外部只有 `probe/capture/apply/restore` 四个操作。
- 契约同时锁定官方包版本与 integrity、被调用的方法集合、session/workspace/projection/query domain 版本，以及六个内部实现文件的 SHA-256；任一漂移都在 capture/mutation 前失败关闭。
- forward mutation 仍调用官方 session/workspace 服务；物理 artifact 恢复、coordinator 清理、workspace 逆操作、projection 恢复与 query reconcile 只存在于 rc.2 host adapter 内部。
- 每个 session 的 apply/restore 在 Core 扩展内串行；live session、snapshot hash 漂移、identity 漂移、非连续 event 和物理 revision 变化均拒绝写入。
- snapshot 保存会话原始字节、workspace 位置/archive、projection row 与 runtime 语义摘要。恢复比较内容与各 domain 的稳定语义；mtime/revision 和 query generation 只用于写前 stale 门禁，不被误当作恢复后的业务差异。
- P15A 只使用合成 fixture；故障注入发生在 session artifact mutation 后，恢复后 session、workspace、projection、coordinator、query 五个 domain digest 与写前一致。
- 本机带 `dsh-desktop patch` 的旧 runtime 仍会因 workspace source hash 漂移被拒绝；P15A 未修改、安装或启动正式 DSH profile。

## 验证记录

- transaction-engine：7 个测试文件、19 个测试通过。
- 全 workspace typecheck：通过。
- 全 workspace build：通过。
- 全仓测试首次并行运行暴露既有 Codex 100-session catalog 用例的 5 秒预算不足；该压力用例改用 15 秒独立预算后，限制四个 test worker 的全仓验证为 32 个文件、82 个测试全部通过。
- portability gate：通过。
- `git diff --check`：通过。
- P15 write-contract：3 个测试通过；全 workspace typecheck/build 与 portability gate 通过。
- P15A Core extension：2 个精简测试通过；新增包与 test-support typecheck 通过，全 workspace typecheck/build 通过，`git diff --check` 通过。
- P15B Gateway/Adapter：Adapter/Core 契约与恢复 4 个测试通过；连同 transaction-engine 回归共 10 个文件、23 个测试通过。
- Core host build gate 同时验证锁定 source hash 与 `dist/rc2-host.js` hash；实际 `pnpm pack` 产物包含完整 host/materialization 文件，解包后 runtime probe 返回 `compatible`。
- 全 workspace typecheck/build 与 `git diff --check` 通过；正式 DSH profile 仍未被读取、修改或启动。
- P16 planner + integration：2 个文件、3 个测试通过；Core/Adapter/transaction/P16 聚焦回归共 12 个文件、26 个测试通过。
- Phase 1 回归 2 个文件、3 个测试通过；全 workspace typecheck/build、194 文件 portability gate 与 `git diff --check` 通过。
- P16 只在只读 DSH Adapter 稳定复核后，用单一 SQLite transaction 推进目标 head、两侧 last-common 与 canonical；重复 apply 不增加 host writes，分叉 plan 在 host mutation 前拒绝。
- P17 operation API：8 个文件、15 个聚焦测试通过；contracts、session-store、local-api-client、engine 定向 typecheck 通过。
- P17 覆盖摘要优先/正文懒加载、100 项分页上限、持久 apply/restore 作业、SSE 续读、严格路径与字段拒绝；restore token 不落盘。
- P18 Dashboard/session-ui：2 文件、3 个聚焦测试通过；两个新包 typecheck、Vite production build 与凭据/路径/未许可依赖 bundle 扫描通过。
- P18 浏览器认证纠错：一次性 launch code → HttpOnly SameSite=Strict UI cookie → per-session CSRF 已闭环；Dashboard bundle 不含 bearer/launch-code 代码路径。
- P19 GitGraph/workbench/plan list：5 文件、8 个聚焦测试和 6 个包 typecheck 通过；production build 将正文/Markdown/计划目录按需分块。
- P19 纠错：1000 节点版本树改为真实 viewport 虚拟化并补齐键盘导航；Checkpoint 恢复独立生成“新 DSH 分支”计划预览且相同选择不重复提交。
