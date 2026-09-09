# Engine 启动恢复与生命周期诊断

## 问题与证据

Launcher 在 Maintenance Engine 没有就绪时启动后台进程，随后只轮询健康接口。后台进程提前退出没有反馈到轮询器，因此即时启动错误被表现成约 240 秒超时。

现场记录表明：Engine 0.1.25 于 2026-09-08 09:10:47（Asia/Shanghai）启动；Windows 随后在 09-08 09:48 和 09-09 06:29 重启，旧所有权及连接记录仍指向重启前的进程。09-09 的 Launcher prepare 耗时 240.786 秒后失败，当天没有新投影运行。隔离复制旧锁状态后，已安装版本立即报告 WRITER_OWNER_CONFLICT。

系统事件证明旧身份跨重启残留，不能证明原进程精确的退出时刻或其是否进入过正常关闭流程。此前正常启动的增量投影耗时约 1.17 秒，整个投影准备约 1.48 秒；本次问题在该阶段之前。

## 最终行为

### 启动与安全接管

- Launcher 后台启动使用 `serve --recover-dead-owner`。该选项只恢复 Engine 所有权；一般离线工具仍使用原有显式恢复方式。
- 复用 `MaintenanceWriteCoordinator.recoverDeadOwner`：同主机、精确 owner ID、PID 已证明不存在、连接归属一致，以及独占恢复门。旧 owner/connection 被归档，真源与投影数据不在此步骤修改。
- 活进程、离线 owner、异机 owner、身份不一致、无法确认死亡和未解决的恢复标记不会被自动接管。不按时间过期删除锁，不凭重启推断 PID 可接管。
- 监测新子进程的 spawn/exit。已失败时返回安全错误码，正常启动中的进程保留 240 秒上限。
- 多个 Launcher 同时启动时，失败方只在核实另一个本机 Engine owner 仍存活的情况下等待其就绪；恢复竞争有至多 1 秒的短暂衔接等待。写锁的互斥规则不变。

### 生命周期记录与关闭

- `logs/engine-lifecycle/<pid>.jsonl` 记录进程启动时间、父 PID、启动、就绪、关闭请求、排空、锁释放、关闭完成及失败阶段。
- 错误只保存允许的错误码；不记录任意错误正文、连接 token、会话正文或请求数据。PID 复用时，启动失败读取还核对本次启动时间。
- 在异步初始化前注册 SIGINT/SIGTERM，避免初始化期间漏掉停止请求；所有正常返回或异常返回都会移除监听器。
- 使用 uncaughtExceptionMonitor 观察致命异常，不改变 Node 默认终止行为。强制终止不能保证留下最后一条日志，因此安全恢复仍是必要机制。
- 服务初始化失败时排空作业并释放本进程已取得的 owner。正常关闭继续先停止服务与作业、排空写入，再关闭数据库和释放 owner；未完成的关闭不被伪装为成功。

### 旧 DSH 运行与投影边界

Engine 的 owner 接管与 DSH run 恢复是两个步骤。前者不证明后者的运行进程已退出，因此不因旧引擎死亡自动把 running 改成 closed，也不删除运行投影。继续使用已有 Runtime Broker 恢复入口及原有所有权、控制/收件记录、尾部和缓存检查。已有未收尾运行仍可能要求恢复，这是明确保留的安全边界。

没有修改会话格式、数据库 schema、Codex 项目名单、增量投影缓存算法或 DSH 插件。

## 验证

- 先增加“子进程失败应立即返回”的回归：原代码在 1 秒测试期限内持续等待而失败；接入监测后通过。
- 7 个测试文件、39 个测试通过：engine-startup、external-lifecycle-provider、runtime-unregistered-recovery、runtime-broker、cli、write-coordinator、persistent-cache。
- 新子进程测试覆盖正常关闭释放 owner/connection，真实强制终止后的恢复及证据归档，并发启动唯一 owner，端口占用后的初始化清理与 EADDRINUSE 记录，活/异机/离线/不确定所有权拒绝恢复，以及错误信息不泄漏。
- 实际失败子进程约 1.2 秒被检测到（含恢复竞争等待），测试要求小于 5 秒；没有将测试机耗时当成所有环境下的保证。
- Engine 类型检查通过；所有测试只使用有标记的合成目录。正常停止测试通过测试 IPC 触发同一 SIGTERM 处理路径，强制停止使用真实子进程终止。
- 未实际重启用户 Windows 做验收，不能将子进程测试表述为完整系统重启验收。

## 交付范围

源码修复提交 bc01b93 仅交付源代码、回归测试和本文档，当时未替换安装版本。用户随后明确要求替换，部署结果如下。

## 0.1.26 部署验收（2026-09-09）

- 发行包来自干净提交 17c101d，安装于 `D:/AI/DSH-Plugin-Releases/maintenance/engine-0.1.26-plugin-0.2.21-launcher-0.2.3`，Launcher 生命周期配置已指向新入口。
- 143 个安装文件中，除 Engine 主程序和 BUILD-INFO 外的 141 个文件与 0.1.25 逐字节一致，包括 Dashboard、DSH Adapter worker 及插件。
- 16:50:12（Asia/Shanghai）以 `serve --recover-dead-owner --port 24215` 启动 PID 47240。实际日志记录旧 owner 恢复成功，startup.begin 至 startup.ready 为 215 ms；这不代表包含 DSH 启动及投影的总耗时。
- 旧运行创建于已核实的两次 Windows 重启之前，当前没有匹配的运行进程。通过 external-lifecycle afterExit（未知退出码、未获正常关闭确认）执行既有恢复，旧运行变为 recovered，建立 checkpoint_dcaffb8690d192912ecc55f8；没有手动清空运行表。
- 只读核对：部署前 7,422 个版本逐行保留，原有 35 个存活会话仍在；恢复正常 Codex 观察后另导入 2 个镜像会话。项目映射策略摘要不变。验收时无占用中的投影运行。
- 健康检查、Dashboard 文件响应和原先正文故障样例的会话 HTTP 读取通过；Dashboard 响应与安装文件一致。
- 回退配置、启动前数据库快照、生命周期日志和部署回执保存在发行目录。回退程序不应覆盖已有新数据的数据库。
- 本轮没有启动 DSH 实例；用户下一次通过 Launcher 启动 0.1.2-rc.1 / web 验收。
