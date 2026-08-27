# P20：事务恢复、适配器诊断与设置

## 结果

- Dashboard 新增“事务与恢复”“诊断”“设置”三个按需加载页面，继续复用同一个 cookie-authenticated typed client。
- 事务页先读取分页摘要，选中后才读取完整 journal、备份摘要与恢复决策；时间线显示步骤、状态和 entry hash。
- Engine 统一计算恢复决策：仅中断状态可进入 journal recovery，仅带可验证备份的 completed 事务可显式 restore；`restore-failed` 与 `manual-review` 只允许诊断。
- 中断恢复与显式 restore 均要求一次性 confirmation。界面先展示操作、事务 ID、作用域哈希和有效期，用户再次确认后才提交持久作业。
- 新增 `recover` 作业类型和 HTTP/client 契约；confirmation token 只存在于当前内存请求，不写入 JobStore。
- TransactionRecovery 的 scope 绑定事务状态、更新时间、最后 journal entry hash 与 backup hash；状态漂移后旧确认不能继续使用。
- 诊断页显示登记 ID、读写契约、能力和问题代码。平台根路径与原始底层错误只保留在 Engine，不进入浏览器 DTO。
- 设置页只接收受约束的实例/映射 ID、同步布尔参数、扫描范围和保留数量；路径形态的 ID 会被 schema 拒绝。

## 安全与失败边界

- 没有“忽略错误继续”或直接改事务状态的 UI。
- 重启后丢失 confirmation token 的 restore/recover 作业失败关闭，必须重新取得当前作用域确认。
- 所有测试仅使用合成 fixture、临时状态根和隔离 SQLite；未触碰正式 DSH/Codex home。

## 验证

- 聚焦门禁：TransactionRecovery、恢复决策、operation API 共 3 文件 / 4 tests 通过。
- 全工作区 typecheck 与 build 通过。
- Windows 全工作区测试固定 `--maxWorkers=1`，避免多个 SQLite WAL/shm fixture 并发产生资源竞争假失败：50 文件 / 111 tests 通过。
- Dashboard production bundle 的 bearer、launch-code API、旧 global、token canary、本机路径、未许可依赖、localStorage/sessionStorage 扫描均无命中。
