# 看板精简、空闲会话释放和未分组副本清理

## 当前交付边界

Engine **0.1.43-rc2.82** / Dashboard **0.1.18** 已安装；Engine PID 65540 已写入 startup.ready。宿主接入 **0.2.27-rc2.50** 最终包已构建并验证实际依赖加载，新增显式 agents 服务依赖，等待测试实例通过 Launcher 正常停止后完成安装和重新签发回执。尚不能宣称运行期 DSH_BUSY 已消除或完整双向同步通过。未使用 Computer Use，UI 由用户验收。

测试实例：`i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5`，native profile `web`，Maintenance profile `web-i27c4`。

## 看板变化

- 保留 Codex–DSH 双向维护和 Codex 项目同步、Codex 镜像设置；前者从“学习双向维护”改为直观名称。
- DSH 同步直接呈现已保存的工作区范围；保留“编辑 → 勾选 → 保存/撤销”，加载中不再出现重复读取按钮，失败时显示重试。
- 设置页保留接入状态和需要处理的问题；添加实例、能力详情、重新检查/断开/内部标识折叠。
- 维护偏好、诊断、适配器信息和历史同步计划归入一个高级区域。旧原生回写配置退出同步页，兼容服务没有删除。
- 删除每行重复的真源徽标，以及无助于当前 DSH 操作的全局旧能力说明。

## 宿主写入边界

释放逻辑仅位于宿主 adapter。捕获宿主 agents.create/resume 返回的正式 AgentHandle，并在同步预约期间挡住新输入；会话状态为空闲且无排队输入时调用原始 dispose，等待其 drain/close 和会话注销完成，才进入维护写入。运行中、排队中、未捕获持有者及关闭失败均不能伪装成已经释放。核心不调用实例或 Launcher 的关闭方法。

接入入口明确依赖 agents 服务，避免因加载顺序漏装捕获逻辑。旧进程中既有句柄不能靠热换磁盘文件补获，需要正常停机。

## 本轮停机判断失误及修正

Status 曾因身份探测未取得响应返回 stopped；按 home 文本过滤进程命令行也未命中实际宿主。随后再次探测发现同一 boot `66d1f4fb-bb42-4d55-9d02-1d1ecf2c0ec5` 仍在线，端口 19876 仍由 PID 68924 监听（Launcher 子进程，启动于 21:18:31）。因此此前据此进行的宿主磁盘安装和副本移出不能记为“停机后完成”。已向用户说明并暂停进一步实例文件修改，请用户通过 Launcher 正常停止。

工作区控制脚本已修正：超时、异常身份响应、没有探测候选均返回 runtime-unverified，而非 stopped；Status 明确 stopVerified=false，不能单独作为正常退出证明。后续安装须核对已确认的 PID/创建时间消失、监听端口关闭及正常退出证据。

Engine 本身的退出真实有效：旧 PID 42704 收到正常 SIGINT，41 秒后出现 shutdown.drained、owner.released、shutdown.completed，未强杀。等待超过脚本 30 秒窗口，已额外复核实际退出并保存回执。

## 四个未分组会话

用户授权删除测试实例未分组会话。以 workspace.json 活跃分组及归档名单排除后，核对到四个旧物理目录下的 dsh-maintenance 派生映射副本；各副本先复制备份并校验 SHA256，再将整个副本目录移至外部恢复目录。其余 64 个原生会话保留，未删除 Maintenance 真源。

当前文件层面四个副本已移出，但由于上述运行状态误判，待正常退出后再次核验是否有宿主残留写入或缓存，并以重新启动后的实际列表完成验收。宿主菜单删除会调用真源删除，故没有拿该接口删除这些孤立副本。

## 证据

- 45 项定向回归、41 项发行包测试、全仓类型检查、Dashboard/插件构建通过。
- 最终宿主包在测试 profile 的实际依赖下加载通过，agents 依赖存在；最终包安装后的持久化探针尚待执行。前一候选已通过该探针。
- 64 项发行构件哈希；1,160 项保留文件校验不变；Engine 重新启动前数据库与备份哈希一致。
- 控制脚本/登录工具 7 项测试通过，覆盖无正常身份响应时不误报停机、拒绝启动、继续禁用 Stop/Restart。

发行目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/engine-0.1.43-rc2.82-final`。

备份和证据：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/dashboard-cleanup-20260922`。`unassigned-delete-plan.json` 给出四个精确对象和哈希；`unassigned-backup` / `removed-native` 提供恢复副本；`backup` 保留配置、存储、数据库及旧插件。
