# ThoughtDAG P3：当前实例会话与画布接入能力

日期：2026-09-14。依据 [会话上下文关系图需求](../superpowers/specs/2026-09-10-session-context-graph-requirements.md) 的 GR01–GR09、AC18–AC21。此提交只修改本地源码，未发布安装包、修改版本组合或部署真实副本。

## 行为

维护插件新增 host-only 的 `maintenanceGraph`（`protocolVersion: 1`）。它绑定 Launcher 已接通的当前运行实例，不向插件浏览器或模型暴露 Engine 凭据。接口包括：

| 接口 | 结果与边界 |
|---|---|
| `directory(workspaceId?, after?)` | 工作区、会话目录元数据；每页最多 50 条，不依赖 Annotation 是否启用 |
| `resolve({logicalSessionId} \| {nativeSessionId})` | 查询当前运行的投影映射，返回逻辑 ID、原生 ID 和标题；不对 ID 字符串反解 |
| `created(nativeSessionId)` | 从官方 DSH 会话对象取得 header，经现有 Runtime Broker 明确登记用户保留的会话，再 flush 和解析逻辑身份 |
| `preview(logicalSessionId, cursor?, selection?)` | 从最新完整问答起分页，或指定 `{sourceVersionId, sourceAnchorId}` 展开已选材料；含可交给 Annotation 的有界选段和回复身份 |
| `relations(after?)` | 当前实例、profile、可见源目标之间的 Annotation 权威关系元数据，每页最多 30 条；无需先打开画布 |

用户未发送问题的普通空白会话仍沿用原来的延迟登记策略。明确新建会话节点会通过 `retainExplicitSession` 保留真实会话身份；该操作不追加虚构消息，不启动 Agent。

画布预览只读现有会话真源及运行投影。DSH 版本 Adapter 负责解释完成事件、回复 anchor 及问答边界，Engine 负责运行范围、源版本校验与分页。默认页优先用户问题和所选完整回复，中间执行过程不进入画布摘要。单页完整 JSON 不超过 16,000 字节，长回复可以连续读取，不切断 Unicode 代理对。浏览预览不创建 Annotation 引用、不产生会话/画布快照，也不赋予模型读取权。

预览游标固定当前版本与读取位置；来源版本改变时明确要求重新选取或刷新，不能把旧材料悄悄改指新回复。这是画布浏览的暂定限制；已经提交的 Annotation 上游引用继续按原有固定版本读取接口工作。

## 画布归属

ThoughtDAG Adapter 接受 `0.4.14-rc2.1`，保留 `0.4.11` 旧画布兼容。新的 `managedSchema: 1` 严格限制为节点、连线、布局及稳定引用：

- 会话节点引用逻辑会话 ID。
- 材料节点引用逻辑会话 ID、来源版本与回复 anchor；可保存最多 4,000 字符的重点摘录，未发送引用不要求已有扩展对象。
- 贴纸和笔记节点引用所属命名空间及对象 ID。协议不复制 Vault 正文。
- 上游/分支连线必须指向 `annotation-upstream` 的关系 ID；领域接口最终核实关系的存在和权限，图自身不保存第二套授权。
- 普通知识线可以仅表示布局；删除呈现不删除 Annotation 关系或真实会话。
- 禁止在 managed 数据中额外附带完整问答、原生事件或模型提示词字段。

旧版完整画布仍可以由已有 Adapter 读取。新接入方应始终写入 managed schema；统一对象存储仍只有当前修订及未解决冲突，无逐次编辑快照。

## 验证

合成目录和会话中验证了以下行为：

- 认证 HTTP 与当前运行范围；伪造/隐藏/缺失身份失败，目录不带正文。
- 无 Annotation 配置及停用后目录继续可读；已保存的权威关系仍能被展示。
- 超长中文、emoji、引号和反斜杠回复逐页完整恢复；完整返回字节数不超额度。
- 材料指定回复、较早轮次、未完成回复排除、旧游标和旧版本失败。
- 查询前后会话/版本/扩展对象数量不变，合成源 home 的文件哈希不变。
- managed 图禁止重复节点、悬空端点、任意上下文字段和伪造命名空间。
- host 请求保留当前 run，登记完成后才解析，错误保留 code/status。
- 显式保留空白会话只登记一次且不追加消息。

相关 9 个测试文件共 38 项测试通过（新增 graph、既有上下文、扩展存储及 runtime 回归）；workspace 类型检查通过。各测试只使用标记的合成环境。

## 范围说明

本提交提供 P3 所需的 Maintenance 后端与图 schema，ThoughtDAG host/frontend 由对应仓库实现。现有 Sticker 协议仍是带回复 anchor 的选段贴纸；独立会话贴纸类型、P2 Vault 写入权迁移，以及全局维护网络不由本提交冒充完成。可选的知识/贴纸来源目录后续可使用其领域能力，当前 `relations` 只返回已实现的 Annotation 上游关系。
