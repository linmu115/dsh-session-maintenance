# 原生上下文管理：运行副本安装验收

2026-09-15 已将原生 Agent 上下文管理安装到 Launcher 的 **0.1.5-rc.2 副本 / web**，从 Launcher 启动并验证实际接口。实现对应[补充规格](../superpowers/specs/2026-09-15-native-agent-context-management.md)，操作说明见[实现记录](2026-09-15-native-context-management.md)。托管引擎未增加此次工具。

## 安装组合

| 组件 | 版本 | 发布源码提交 |
| --- | --- | --- |
| Maintenance Engine / 插件 | 0.1.33-rc2.20 / 0.2.26-rc2.16 | `226d1d5` |
| Annotation Core | 0.3.12-rc2.11 | `73555da` |
| ThoughtDAG | 0.4.14-rc2.9 | `9c6b404` |
| Sticker Board | 0.7.3-rc2.17 | `2fa367e` |
| Sidechat | 0.4.7-rc2.11 | `aa4f2c9` |
| Obsidian Bridge Lifecycle | 0.3.3-rc2.15 | `753a948` |
| Obsidian Reference Adapter | 0.3.4-rc2.15 | `bbd53a0` |
| Obsidian Session Reference Suite | 0.3.4-rc2.17 | `55d7bbb` |

本次更换八个插件；完整 Profile 的十九个插件名称、版本、包摘要和实际安装文件已核对。二十二处插件间 peer 约束及官方严格安装通过。未改动的 Protocol 使用原有 `0.3.3-rc2.1`，没有另外复制源码。八个相关仓库的上述提交及 README 已推送到现有开发分支；未合并到主分支。

## 运行验证

- Core 全部 239 项测试，五个配套仓库全部 322 项测试通过。Maintenance 的请求索引、窗口、权限、事务回滚、预算及持久释放证据回归通过；ThoughtDAG 与 Dashboard 的相关交互测试通过。构建和类型检查通过。
- 原生 AgentLoop 使用脚本化模型执行真实请求装配，证明首次直接释放不依赖先查状态、下一次请求确实移除目标正文、用户评论和其它材料继续保留。Engine 在替代事件尚未持久提交时拒绝成功回执，持久提交后才接受；使用自行验证的释放量。
- 新发布包通过便携性和内嵌插件一致性检查。实际十九插件宿主用合成会话验证写入、回滚、锁、网关及新进程冷读取，所有检查通过。
- 旧副本通过已安装的退出接口进入 `appExit`，官方生命周期最终记录为 `recovered/finalized`，有最终回执；没有直接改写运行状态。确认没有活动运行与任务后保存升级前备份，再安装与切换 Engine。
- Engine 切换前后，会话真源的 534 个会话头、251,622 条规范事件、7,879 个版本及对应摘要一致；数据库保持 schema 24。现有注释数据和主实例配置摘要未变。
- Launcher 中副本已经显示运行中。实际安装的六个 namespace 均为 ready：`annotation-context`、`annotation-records`、`annotation-upstream`、`obsidian-links`、`stickers`、`thoughtdag`。
- ThoughtDAG 实际状态披露 `nativeContext: true`；从图接口经过当前宿主读取上下文状态，返回正确会话归属；Maintenance 规范会话请求目录可以读取；客户端覆盖归属参数被输入校验以 422 拒绝。已移除的全局网络接口仍返回 404。

运行验收使用读取操作，没有发送真实模型请求、修改现有图关系或联系真实 Vault。实际模型是否主动选择某项工具仍需在具体对话中观察；接口可用和脚本化执行验证不等于替用户完成了真实模型行为验收。

## 用户入口与生效时间

在接收会话的思维图中右键来源卡片，选择“管理来源上下文”。用户请求索引用于选择对应轮次；窗口可包含不连续区间。暂停、释放、解除分别表达不同操作，默认用完后释放材料并保留图边。用户固定材料不能被模型普通释放操作移除。

原生 Agent 的九个管理工具在匹配能力启用时可用，仅操作自己的主干。释放先记录意图，在后续原生请求准备时替代输入视图，持久核验通过后显示生效；已经发出的请求不会被追溯撤回。停用能力时，无插件材料的普通聊天继续；仍有保留材料或待注入引用的请求等待能力恢复，防止绕过既有约束。

本机完整安装、备份、宿主及启动回执位于 `D:/AI/DeepSeekHarness-Plugin/artifacts/native-context-management-20260915/`，最终运行证据为 `validation.json`。这些本机回执不上传会话内容、凭据或完整数据库到 GitHub。
