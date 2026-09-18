# 同步子栏目与当前运行范围修复

日期：2026-09-18。基线：e8c5d01。交付版本：Dashboard 0.1.5、Engine 0.1.33-rc2.39。

同步页面原先把 DSH 实例范围和 Codex 项目映射两个完整表单上下堆叠。现在提供同级的“Maintenance 工作区同步”和“Codex 项目同步”标签，每次显示一个子页。首次访问才读取该子页，访问后保持挂载，来回切换保留选择、搜索和保存反馈；切换本身不保存名单、不激活策略。标签支持方向键、Home/End、可见焦点和关联的 tabpanel。整个同步主页面离开/全局刷新仍沿用原有卸载行为，草稿不持久化。

实例卡片原先使用没有定义样式的 surface-body，现改用现有 settings-content 间距。当前运行范围和已保存范围使用一致的摘要卡片，移动宽度下卡片纵排，两类同步入口仍然并列并允许文字换行。运行范围列表默认折叠、展开后限高；每个不同 run 保留独立记录和完整运行标识，不按 profile、范围或 revision 合并。名单表单、保存区、错误与空状态复用原有组件与主题变量。

31 条相同范围铺开的数据根因位于 InstanceWorkspaceRuntime.readConfiguration：它将包括 recovery-required、quarantined、cleanup-pending 的所有未关闭数据库记录都输出为 activeScopes，却没有使用 effectiveScope/availability 已有的在线判断。现在同时要求记录处于开放状态、RuntimeBroker.isRunActive 为真。旧运行记录、冻结范围和数据库完全保留；仅配置读取 DTO 的 activeScopes 和由它计算的 pendingActivation 改为当前在线运行。不同在线 run 即使 profile、revision、selection 相同仍全部返回。

现有 Dashboard run-center API 只有持久化 ProjectionRun.state、租约和阶段记录，没有 RuntimeBroker 在线标识，不能把 running 字符串当作在线证明，因此没有添加前端猜测过滤。只部署 Dashboard 0.1.5 时旧 Engine 仍可能返回旧范围；页面先折叠展示。根因修复需要正常激活 Engine 0.1.33-rc2.39，不能宣称静态页面更新已激活服务端修复。

验证：

- Dashboard 全部测试及 Engine instance-workspace-runtime/service/http 回归：27 个文件、89 项通过。
- 新增交互测试覆盖两个同级标签、首次访问读取、双向切换保留两份草稿、不调用保存、键盘导航及 ARIA 关联。
- 新增范围测试覆盖全部开放历史状态与 closed、离线 running、多条相同 profile 的真实在线 run、等待激活计算，以及读取不新增冻结快照/不删历史。
- Dashboard 与 Engine 类型检查、生产构建通过；git diff --check 通过。
- 产物为 apps/dashboard/dist 与 apps/engine/dist；发行打包单独记录在主任务。

边界：本提交未部署、未停止/重启真实实例、未读取或修改真实会话/同步名单/Vault。所有写入测试使用标记的临时合成夹具。实际浏览器布局、窄屏、深色主题、焦点视觉和真实交互 UI 未验收，由主任务验证；DOM 测试和构建不替代视觉验收。Engine 0.1.33-rc2.39 当前待正常激活。
