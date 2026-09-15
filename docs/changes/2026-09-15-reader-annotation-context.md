# 折叠 Annotation Core 注入上下文

Annotation Core 把已准备的引用材料写成原生 `user/message`，来源为 `source.kind: dsh-annotation`。此前阅读适配器只识别通用 plugin 和 skill-catalog 来源，因而把这条注入材料当成第二条用户提问：真实提问被单独拆为上一轮，自定义标签材料在下一轮显示成空的“你”气泡。

DSH 0.1.5 阅读适配器现在识别 Core 的明确来源信封：`kind: dsh-annotation`、`schemaVersion: 1`、非负整数 count，以及有界的 setId、targetUserMessageId 和 digest。符合条件的记录归为 `plugin-context`，显示为“引用上下文”，放入所属问答轮次的过程目录。该判断不扫描消息正文，不改变 canonical role、事件内容或模型可见范围。

SQLite 列表查询只提取这些有界来源标量。引用正文继续仅在用户打开具体过程条目时分段读取。普通用户粘贴 `<dsh-annotations>` 标签、未知或无效来源信封、仅含附件的用户消息不会被这条规则折叠。

两个新增合成用例连同现有 Adapter 和 Engine API 相关测试共 19 项通过。测试确认 user + annotation + runtime + answer 为一轮，主列表和过程目录不携带注入正文，展开后可读取原文；用户粘贴内容、图片附件消息及原 canonical 事件保留。Adapter 和 Engine 类型检查、Adapter 构建、`git diff --check` 通过；整包构建由发布任务在本提交后执行。没有修改真实会话或读取真实引用正文，组件版本保持不变。
