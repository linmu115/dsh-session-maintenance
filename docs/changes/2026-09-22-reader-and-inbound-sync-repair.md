# 阅读器校验与实例回传修复

## 当前状态

2026-09-22 23:49：Engine **0.1.43-rc2.83** / Dashboard **0.1.19** / 宿主 **0.2.27-rc2.51** 已安装。当前 Engine PID 34548、ready；正式接入 repair 返回 connected、issues 为空。测试实例保持停止，等用户启动验收，不将运行期双向同步或 UI 标记为通过。

用户指定的独立点击脚本调用现有 Launcher 停止按钮，原宿主 PID 63812 和 19876 监听均消失。Launcher 日志退出码为 1，仅作为实例退出证据，不宣称宿主业务 flush 已验收。未修改 Launcher 本体，先前越界开发已撤回。旧 Engine PID 62868 经正式停止脚本完成 drain / owner-release / completed 回执后，离线备份数据库、profile、原生会话及插件状态，再安装 .51 并重新签发实际能力回执。

安装后实际模块加载、持久化能力探针、64 项发行文件校验通过；1,245 项保留文件哈希一致，profile 中除 Maintenance 依赖版本外其余字段一致。范围修订 8、原三个工作区、排除未分组均保留。看板首页及入口资源 HTTP 200。实例停止时同步页返回“尚未取得正在运行的宿主身份”，待启动后复核，不把它当作已解决或新的运行期失败。

## 用户可见故障与原因

1. 阅读页的 processKinds 校验不接受 opaque-data。引擎类型和查询早已将未知记录折叠成该类别，但 Zod 接口枚举漏了一项；未知记录存在即使整页读取失败，归档后的刷新暴露了该缺口。补齐枚举，并由同一个 schema 推导 TypeScript 类型，防止两套定义再次分歧。
2. 原生测试会话刚创建时 3 条初始化记录已进入真源。之后实例追加到 20 条，但 discover 对已有身份直接返回 already-present；refresh 又受全局对齐阻塞，因此正文长期不进真源。增加可选 adapter 证明入口：仅本实例原生、非投影、非墓碑、全部事件归属和格式一致、原历史前缀逐条一致的会话，允许在对齐前刷新。派生/投影会话继续保持原约束；失败、缩短、改写或外来历史不得覆盖真源。
3. 对齐曾写出部分会话，刷新失败后保留完整恢复范围；下一次 unchanged 检查跳过部分已写入会话，传给屏障的范围变小，遂反复返回 HOST_RECOVERY_SCOPE_REQUIRED。宿主 .51 在重新分类前，先取得原完整范围及插件访问保护，执行已有 refresh/release 恢复；原失败未解决时仍不得开始新写入。

单会话回传改用 loadSessions，避免每次为一个会话加载整套真源历史。对齐失败原因保留到下一次有结果的重试；宿主拒绝回执附带受限的失败阶段，避免重试时抹掉错误信息。

## 已运行验证

- 58 项定向回归通过：真实 HTTP 客户端解析未知数据包；原生追加、改名、移动、归档及前缀/来源拒绝；未激活范围内可选证明入口；失败恢复先于 unchanged 分类；屏障与 UI 过程折叠。
- 41 项发行包验证、全仓类型检查、看板及接入组件构建通过。
- 旧 Engine PID 59120 正常 SIGINT，drain / owner-release / completed 回执通过；离线备份数据库和安装配置，再切换 .83。DSH 实例 PID 63812 未被停止或替换。
- 对实际会话走正式 sync-changes/discover 接口：`session-8a0c7487-0266-43fc-bbdd-a4e21f396175` 从真源 3 条补齐到 20 条；`session-1596eacd-f815-4c3d-85df-895b8f17c2ac` 保留 29 条，归档状态同步为 true。
- 使用与看板相同的 development 源码条件打包 MaintenanceClient，对上述两条实际会话的阅读页与过程页均校验通过。首个诊断脚本默认解析到仓库旧 dist，曾重现旧枚举错误；切换为和 Vite/发行脚本一致的条件后通过，不把旧诊断产物当成线上新版结果。
- 只读比较当前原生文件：117 个文件可由实际宿主读取/回放；其中一条旧会话（661 事件）被 adapter 的严格 protected surface 校验拒绝。没有修改其历史或放宽该校验；这是其他历史兼容性的独立未解决项，不是本次新测试会话的导入阻塞原因。

## 待完成

由用户启动测试实例；启动后确认宿主 .51 实际生效、全局对齐能完成、新建和续写自动回传、归档与取消归档、投影会话双向变化，以及阅读器和过程折叠的 UI 验收。当前停在人工验收边界，不自动启动实例、不操作验收 UI。

发行目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/engine-0.1.43-rc2.83-final`。

证据和备份：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/reader-sync-repair-20260922`，包括 live-reader-and-sync83.json、alignment-poll.json、native-read-comparison.json、backup-engine82、backup-profile50。报告只包含身份、状态和计数，没有输出会话正文或连接令牌。
