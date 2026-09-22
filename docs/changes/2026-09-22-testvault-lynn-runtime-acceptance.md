# testvault Web Viewer 验收与 Lynn 服务身份修复

后续更新：用户正常停机后，Engine **.74** 和接入组件 **.47** 已安装并通过后端校验，测试实例保持停止，后续 UI 由用户亲自验收，不再使用 Computer Use。见 [修复安装与人工验收交接](2026-09-22-lynn-rc47-installed.md)。以下为安装前的实机记录。

2026-09-22 18:22：按用户要求，在 testvault 的 Obsidian 内置 Web Viewer 中验收 DSH WebUI。测试目标为 `i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5`，物理 profile `web`、Maintenance profile `web-i27c4`。当前 Engine **0.1.43-rc2.73**、实例接入组件 **0.2.27-rc2.46**，目录接入 connected、issues 为空。实例已由正式 Launcher 启动入口启动，当前运行；此前“留待启动”是历史状态。

## 实机已验证

- 内置 Web Viewer 加载当前测试实例；新建独立验收会话并取得真实模型回执。
- ThoughtDAG 显示对应会话节点及已保存状态。
- 未选择来源时会话贴纸拒绝创建；选择测试 AI 回复后，新会话携带待发送引用，提交后取得模型回执，引用详情可读。
- 新建 `D:/obsidian/testvault/Lynn验收-20260922.md`，从编辑器选择测试文段，经“引用到 DSH”进入同一 Vault 的内置浏览器；提交、真实模型回执和引用详情通过。
- 从 DSH 引用跳转到该笔记并高亮测试文段；笔记生成折叠 DSH 回链，激活回链可返回对应会话。磁盘笔记含本次块标记及正确 native session ID。
- 两个测试会话通过正式 native codec 读取，分别有 19 / 30 条事件，完整性为 true。UI 问答共三轮；原始 user/message 事件含更新操作，不等同问答轮数。

测试数据保留供修复后继续验收：

- `session-958e9414-5d00-4002-988f-322f514d078f`
- `graph-session-1d65b4b1f4cd4766031c078c659e812e`
- `D:/obsidian/testvault/Lynn验收-20260922.md`

未修改既有会话正文、既有笔记、Vault 绑定和 Maintenance 同步范围。新建会话使用现有 Demo 工作区，仅将新建的测试笔记用于引用。

## 验收发现的缺陷及修复

真实宿主 `/workspace-sync/plugin-data` 仅返回 `core/extensions`、`dag/extensions`，漏掉 `core/session` 与 `stickers/session`。原因是 Cordis 为 Service 返回不同的上下文代理，Lynn 比较代理对象本身，导致已安装写入门禁的服务仍被判为未握手。

Lynn adapter 改用 Cordis 提供者的原始对象身份比较，保留卸载/替换服务后重新握手的要求。Maintenance 核心没有增加插件或 Launcher 判断。新增真实 Cordis Service 回归先复现失败，修复后通过；覆盖 Core/Sticker 捕获和服务卸载后的能力撤销。

验证：20 项相关测试通过；Lynn 与接入插件类型检查通过；构建通过。当前 Core、Sticker、已安装 DAG 的实际读写器在隔离数据上往返通过，未知数据保留、缺插件跳过、并发修改拒绝覆盖均通过。58 个候选包文件哈希一致；候选宿主入口在实际测试实例依赖闭包下 import 通过。

候选包 **Engine 0.1.43-rc2.74 / 接入组件 0.2.27-rc2.47**：
`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/engine-0.1.43-rc2.74-candidate`

此候选尚未安装。测试实例继续运行 .46，不能将修复后单元/隔离验证表述为真实运行数据映射已通过。

## 待完成与证据

按工作区约定，外部 Launcher Stop 未接通，不直接 shutdown 或杀进程替代。已请求用户从 Launcher 正常停止测试实例；停止核实后备份并安装候选、更新回执、重新启动，然后继续完整捕获、插件映射回验与工作区生命周期验收。

改名、移动工作区、归档、取消归档、删除及 Maintenance 完整往返尚未通过本次实机验收；GPT adapter 只有相关测试通过，真实 GPT 数据映射未验收。此前 Launcher 自带窗口 HTTP 431 未修复，本轮成功界面是 testvault 内置 Web Viewer。

证据：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/testvault-acceptance-20260922/verification.json`；候选加载证据：`SYNTHETIC-rc2.47-module-probe/verification.json`。报告只记录身份、状态和计数，不记录令牌或历史正文。
