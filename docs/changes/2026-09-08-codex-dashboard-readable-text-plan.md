# Codex 看板正文为空：原因核查与修复方案

状态：根因已确认，修复方案待实施。本文件不表示代码已修复或已部署。

核查基线：078c5f8，Engine 发行包 0.1.24，Dashboard 0.1.1。采用只读数据库连接检查当前 Maintenance 真源，以及一个已在看板发现异常的 Codex 来源会话。当前 HTTP 监听未运行，因此真实数据复现直接调用生产 `SessionMaintenanceQueries`，没有启动实例、执行导入或写入真实数据库。

## 已确认原因

`apps/engine/src/codex-canonical-import.ts` 的 `canonicalCodexEvent()` 将已规范化正文保存为 `{ text, attachments }`。这是当前导入路径的正常数据结构，旧迁移也采用同类结构。

`apps/engine/src/session-maintenance-queries.ts` 的 `readCanonicalDashboardSession()` 为 DSH 调用专用读取函数，但对非 DSH 事件只接受 `typeof event.content === "string"`，其余一律返回 `readableText: null`。因此包含非空 `content.text` 的 Codex 消息也被标记为空。

`apps/dashboard/src/canonical-event-view.tsx` 使用 `readableText` 渲染用户和助手正文。收到 null 后展示“这条消息没有可显示的文字”。前端没有删除正文，Markdown 渲染器也没有得到正文。

Git 追溯：查询分支来自 99720a8，前端使用可读正文的逻辑来自 d15609d，均早于 B 主题提交 078c5f8。

## 范围与证据

2026-09-08 只读快照中，35 个未删除会话里有 32 个 Codex 镜像会话包含受影响的普通消息：用户消息 467 条、助手消息 431 条，合计 898 条。它们均是对象内容且 `content.text` 非空。这一计数仅覆盖当前未删除会话的当前事件索引，没有扫描全部删除记录与历史版本。

抽查一个会话：

- 10 条普通消息的 `content.text` 均非空。
- 生产查询返回的 10 条消息全部 `readableText: null`，原 content 仍完整返回。
- 重新只读运行现有 Codex normalizer 后，10 条消息正文与索引完全一致。
- 读取当前 head 正文对象并核验对象摘要，10 条消息与索引内容一致。
- 抽查的两条助手原始消息分别有 47 和 2378 个 JS 字符单位，与已保存正文逐字一致。
- 用户消息的原始封装含环境/内部上下文或传输空白，需按既有 normalizer 规则比较；不能把封装与可见正文的长度差直接认定为丢失。经过同一规范化函数后，本例 10 条均一致。

因此，本次已核查问题是查询投影遗漏正文读取规则。无法由该快照推断所有历史数据都无其他问题；但修复这 898 条现存正文的显示不需要重新导入。

## 最小复现

使用仓库合成 Codex home，调用真实 CodexReadAdapter 的 list / observe / normalize，再通过 `canonicalCodexEvent()` 保存到合成 Canonical 仓库，启动合成 Engine HTTP API，由 MaintenanceClient 读取。

测试先断言 API 原 content 与导入内容一致，通过；随后断言可读正文与导入的 text 相同，稳定失败：

```text
Expected: ["hello from fixture", "fixture response"]
Received: [null, null]
```

诊断入口、日志和无正文的摘要证据位于工作树 `.artifacts/`，不进入生产构建或默认测试集。此次复现测试的失败是问题证据，不是“测试通过”。

## 测试为何遗漏

现有 `canonical-dashboard-api.test.ts` 的 Codex 示例使用纯字符串 `content: "静态正文"`，没有经过真实导入转换。阅读页测试直接提供 readableText，因此可以验证渲染，却不能证明 Codex 导入到查询的连接完整。DSH 的原生消息有相应适配器读取测试，Codex 缺少对等覆盖。

## 修复施工范围

### 1. Codex 的只读正文呈现

在 `packages/adapter-codex-read/src/readable-text.ts` 新增并导出 Codex Canonical 正文读取函数。识别已知纯文本记录的 `{ text, attachments }`，兼容旧的纯字符串内容。保留原换行、Markdown、Unicode 和正文顺序；不对保存内容再次进行平台封装清洗。

未知或不支持的事件继续保留原始记录。工具参数、来源元数据、附件地址不能通过递归搜索 text 被误认成用户/助手正文。只处理已确认的内容形状和事件类别，避免用 JSON 序列化冒充回答。

### 2. Engine 查询接入及提示修正

在 `readCanonicalDashboardSession()` 按事件来源调用 Codex 或既有 DSH 读取函数，继续只在返回 DTO 上添加 readableText。不修改持久化事件契约、contentDigest、版本 ID、对象内容、事件索引或项目映射策略。

前端继续消费统一可读正文并使用现有 SafeMarkdown。对 null 的提示改为“暂未解析出可读正文，可展开原始记录查看”，避免把读取器未识别的内容断言为无文字。引擎未提供字段的兼容提示单独保留。

### 3. 回归与验收

将合成复现纳入正式测试，必须覆盖真实导入转换到 API 的路径。增加对象正文、旧字符串、空/附件消息、未知事件、工具和元数据排除、DSH 原生及混合来源会话回归。确认调用前后保存的 event_json、正文摘要和版本数量一致。

页面测试从实际导入并查询得到的数据检查 Markdown 标题、列表、表格和代码，而非只手填 readableText；验证普通回答不再显示占位提示，其他记录保持原有折叠类别。重新跑相关 Codex Adapter、Engine 查询、Dashboard 测试与类型检查、构建。

### 4. 发布

本次必须更新 Engine 查询代码，不能仅替换 B 主题页面资源。保留 B 主题，升级相应 Engine / Dashboard 包并留下可回退产物。发布前重新检查当前运行；如有活动实例，使用既有受控停止/恢复流程，不能强行中断正在写入的运行。

部署后复核受影响样本和当前可维护范围的消息：有正文的消息应得到相同正文，版本、索引与映射范围保持一致。无需清空真源、重新扫描全部 Codex 会话、创建补丁版本或改写 Codex 原始文件。

## 验收目标

已保存的正文直接恢复为静态 Markdown 显示；新导入的同格式 Codex 消息也正确显示。改动局限于正文读取和提示，数据仍使用原有版本与来源证据。当前阶段未实施上述修复。
