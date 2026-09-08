# Codex 静态会话正文读取修复

Engine 0.1.25 / Dashboard 0.1.2 / Codex Read Adapter 0.1.1，Maintenance 插件继续使用 0.2.21。

## 问题与结果

Codex 导入将正文保存为 `{ text, attachments }`，原查询只接受非 DSH 的纯字符串 content，造成正常保存的 Codex 用户和助手消息得到 readableText: null。修复后，查询提供原有 text，静态阅读页使用既有 SafeMarkdown 渲染。B 主题保留。

## 实现范围

- Codex Read Adapter 导出 readCodexCanonicalEventText，仅解释用户、助手、系统文本与可读推理记录的已知 Canonical 对象/旧字符串形状。
- 原换行、空白、Unicode 与 Markdown 保持不变；不再次运行源文件的用户上下文清洗。
- 空正文返回 null；附件地址、工具参数、其他/未知事件、嵌套元数据、未经识别的原生数组和其他平台交给既有相应路径，不能被递归搜集成回答。
- Engine 查询按事件 source.platform 选择读取函数；DSH 继续使用现有读取函数，支持同一个会话包含不同来源的事件。
- readableText 仍为查询 DTO 字段，不进入持久化事件，不改变 content、contentDigest、事件 ID、版本、索引、对象或映射规则。
- 看板的 null 提示改为“暂未解析出可读正文”，避免把未识别内容断言为空。旧引擎未提供字段时保留独立提示。

## 验证

1. 新增完整回归：合成 Codex rollout → 真实 Adapter observe/normalize → canonicalCodexEvent → CanonicalSessionEngine 保存不可变版本 → HTTP API → CanonicalEventView / SafeMarkdown。
2. 修复前上述测试返回 `[null, null]`；修复后显示正常正文、Markdown 标题、列表、表格、代码，并保留图片占位和 HTML 不执行规则。
3. 测试核对读取前后的源 rollout、持久化事件、会话记录、版本行及版本内容一致。
4. Codex Adapter 阅读器 10 项测试覆盖旧字符串、对象正文、混合附件、空正文、未知/工具/元数据排除和 DSH 来源隔离。
5. 相关 Codex Adapter、DSH 阅读器、Engine 查询与 Codex 导入、Dashboard 和契约共 23 个文件、109 项测试通过；Codex Adapter 构建、Engine 与 Dashboard 类型检查通过。
6. 对当前真实 Maintenance 库使用只读连接运行生产查询：35 个未删除会话中，32 个 Codex 镜像会话的 898 条非空普通消息全部逐字等于已保存 text，11 条 DSH 普通消息继续可读。logical_sessions、canonical_events、session_versions 和 codex_project_mapping_policy 的全行摘要在读取前后完全一致。

诊断和只读验证没有启动 DSH、重新导入源会话或改写真实数据库。未扫描全部已删除会话与历史版本，统计仅代表验证时的当前可见范围。

## 发布与回退

本次更新 Engine 主程序及 Dashboard，必须启动新 Engine 才能使用新的读取逻辑。发行时核对 DSH 插件与 Adapter worker 未变化，保留旧发行目录及 Launcher 配置备份。当前运行状态在切换前重新检查，不能因替换文件就宣称运行进程已升级。

无需清空真源、改变白名单、重建会话或添加修补历史版本。若回退，只需在无活动写入时恢复上一个 Launcher 配置和 Engine 发行包。实际源码提交、产物摘要、运行 PID、HTTP 验证和浏览器验收写入本机部署回执。
