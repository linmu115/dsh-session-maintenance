# Maintenance Canonical Session Format v1（MCSF v1）

状态：第一版可执行契约  
日期：2026-09-03  
首个投影目标：DeepSeek Harness 0.1.2-alpha.2 格式族

## 1. 名称与唯一真源

`MCSF` 是 Session Maintenance 真源内部使用的稳定数据格式，不是另一个数据库、镜像或第三份真源。

```text
Codex 原生日志（Codex 自己的只读权威源）
                 │ 导入
                 ▼
Session Maintenance Canonical Store
        （MCSF；DSH 投影的唯一真源）
                 │ Adapter 投影
                 ▼
DSH Alpha2 原生会话文件（可重建派生视图）
```

Maintenance 不修改 Codex 原生日志。Codex 会话导入 Maintenance 后形成只读镜像版本；在 DSH 中第一次续写时，按既定规则派生新的 Maintenance-owned 会话。

文档或代码中的 `Canonical → Alpha2` 只表示“从 Maintenance 中的 MCSF 数据投影到 Alpha2”，其中 `Canonical` 不是另一个存储。

## 2. 为什么不直接采用 Codex、MCP 或某个现成格式

目前没有一个通用标准同时规范：持久会话、消息、工具调用关联、项目与工作区、派生分支、墓碑、Checkpoint、原生格式往返和版本 Adapter。

MCSF 只借用现有规范中已经稳定的交集语义：

- OpenAI Responses 的 item/call ID 思路：工具调用与结果通过稳定 `call_id` 关联；
- MCP 的结构化工具输入、结果和错误表达；
- DSH 的 `user/message`、`assistant/message`、`tool/call`、`tool/result` 与日志面/消息面的明确区别；
- Codex 原生日志只作为 Codex Adapter 的输入证据，不作为 MCSF 本身。

参考：

- [DeepSeek Harness Alpha2 Session types](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/core/session/src/types.ts)
- [DeepSeek Harness Alpha2 Session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/session.zh.md)
- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
- [Model Context Protocol tool schema](https://modelcontextprotocol.io/specification/2025-06-18/schema)

Codex 的数据较丰富，但“以 Codex 为标准”会把 Codex 的审批、环境上下文、内部调度和流式实现细节固化成所有 Harness 都必须理解的核心类型。MCSF 因而采用交集模型，Codex 特有语义由 Codex Adapter 翻译或降级为 `other`。

## 3. Deep Module 与三个接口

MCSF 作为 Deep Module，对外只暴露三个小接口：

```text
CanonicalStore
  readSession / appendVersion / listChanges

HarnessAdapter
  normalizeNative / materializeNative / verifyProjection

AdapterEvidencePort
  putEvidence / readEvidence
```

- `CanonicalStore` 拥有会话的稳定语义和版本图；
- `HarnessAdapter` 拥有某个不兼容原生格式族的准确字段知识；
- `AdapterEvidencePort` 由 Adapter 使用，保存无法进入公共语义的原生证据。

原生事件类型、Schema fingerprint、原始 payload 和 replay policy 不应扩散进 MCSF 公共字段。MCSF 的 `other.evidenceRef` 只保存不可变引用。当前历史记录中的 `rawPayload` 是迁移前兼容字段；新 `other` 事件不得依靠它投影到模型消息面。

M02 已把这个边界落成 `AdapterEvidencePort`：证据使用 Canonical JSON 编码后写入现有内容寻址对象库，SQLite 只登记 `evidence:sha256:<digest>`、所属 Adapter、原生格式族和摘要。`readEvidence` 必须同时给出拥有者 Adapter ID；其他 Adapter 得到 `undefined`，公共会话读取接口没有自动展开证据的能力。证据对象进入 GC 可达集合，但不成为第二份会话真源。

## 4. 会话身份与“Source Binding”

真源内容没有拆成 Codex、DSH 两类。平台会话 ID 只是索引，不拥有内容。

逻辑上统一称为 `Native Session Reference`：

```text
logicalSessionId
platform
instanceId
nativeSessionId
adapterId
referenceUse = source | active-projection | historical-alias
runId?       = 仅活动投影需要
```

其中：

- `source` 找回 Codex 等外部只读来源；
- `active-projection` 找到本次运行生成的 DSH ID；
- `historical-alias` 保证旧链接仍能解析。

三者可以在数据库内部因生命周期和事务约束使用不同表，但 WebUI、Adapter SDK 和概念模型只展示一张引用索引。它们不复制 MCSF 会话正文，也不形成第二真源。

## 5. MCSF v1 公共事件交集

首版稳定种类：

```text
user-message
assistant-message
system-message
reasoning
tool-call
tool-result
annotation
sticker
obsidian-reference
attachment
system-metadata
other
```

`opaque-unknown` 只保留为历史兼容输入；新导入器必须生成 `other`。

每个事件仍包含稳定 ID、逻辑会话 ID、顺序、语义种类、角色、规范内容、来源索引、内容摘要和扩展引用。事件种类决定默认可见性，Adapter 只能缩小可见性，不能把 `log-only` 扩大成 `model-visible`。

## 6. `other`：不可翻译语义的安全容器

当来源 Harness 和目标 Harness 无法一一映射时：

1. 可等价表达的部分进入公共事件；
2. 不可等价表达的部分进入 `other`；
3. 原始平台证据通过 `evidenceRef` 留给来源 Adapter；
4. 目标 Adapter 只输出非 Surface、可忽略的维护事件；
5. DSH 客户端把该事件渲染成折叠的工具样式卡片。

`other` 内容形状：

```ts
interface CanonicalOtherContentV1 {
  schemaVersion: 1
  type: 'other'
  reason:
    | 'no-common-semantics'
    | 'unsupported-source-event'
    | 'orphan-tool-result'
    | 'adapter-evidence'
  sourceKind: string
  label: string
  summary: string
  evidenceRef: string | null
}
```

硬性不变量：

```text
other
  presentation = tool-card
  modelExposure = log-only
  DSH surfaceOp = absent
  DSH event type = maintenance/other
  DSH ignorable = true
```

“工具样式卡片”只是 UI 表现，不能伪装成核心 `tool/result`。真正的 `tool/result` 会进入 DSH 派生模型历史，并要求前面存在匹配的 tool call；滥用它会重新造成孤立 `role: tool`、请求拒绝或内部结构泄露。

## 7. 工具调用关联

MCSF 工具链至少满足：

```text
tool-call.callId == tool-result.callId
```

Alpha2 投影时形成：

```text
assistant/message（含 tool-call block）
tool/call（日志记录）
tool/result（sourceEventSeqs 指向匹配的 tool/call）
```

无法配对的旧工具结果不得进入消息面。它进入 `other` 或 Adapter 隔离证据，并在兼容性报告中留下诊断。

## 8. `assistant/chunk` 是什么，为什么不能伪造

`assistant/chunk` 是模型实时生成期间产生的 token/delta、用量和结束原因等流事件；`assistant/message` 是组装完成后的最终消息。

导入一个已有最终回答不等于重演原始流。如果 Codex 来源只提供最终 Assistant item，而没有当时的原始 provider chunk：

- 生成 `assistant/message`；
- 不伪造 `assistant/chunk`；
- 不伪造 chunk 顺序或时间；
- 不声称不存在的 `sourceEventSeqs` 来源关系。

DSH 官方类型也把 `assistant/chunk` 描述为用于 token-level replay fidelity 的原始流，而模型历史由组装后的 `assistant/message` 派生。现有 Codex 导入插件采用相同思路：

- [Gordonynh/dsh-plugin-codex-import](https://github.com/Gordonynh/dsh-plugin-codex-import)
- [xing01l/session-import-codex](https://github.com/xing01l/session-import-codex)
- [huguangyu666/dsh-plugin-session-import](https://github.com/huguangyu666/dsh-plugin-session-import)

这些实现可用于核对字段和行为，但 MCSF Adapter 不复制其私有事件或旧版写盘格式。

## 9. Alpha2 首版精确映射

| MCSF | Alpha2 | 模型可见 | 说明 |
|---|---|---:|---|
| `user-message` | `user/message` | 是 | `surfaceOp: append` |
| `assistant-message` | `assistant/message` | 是 | 最终消息；不伪造 chunk |
| `tool-call` | `assistant/message` tool-call block + `tool/call` | 是/日志 | 保持同一 call ID |
| 已配对 `tool-result` | `tool/result` | 是 | `sourceEventSeqs` 指向调用 |
| 孤立 `tool-result` | `maintenance/orphan-tool-result` | 否 | `ignorable: true` |
| `other` | `maintenance/other` | 否 | 工具样式卡片；无 `surfaceOp` |
| 其他暂不支持事件 | `maintenance/<kind>` | 否 | `ignorable: true` |

Alpha2 的准确字段必须以对应版本的官方源码、类型声明、测试 fixture 和隔离实例日志为证据；不得用字段名猜测。

## 10. Adapter 版本原则

一个不兼容的原生会话格式族对应一个人工维护 Adapter，而不是每个产品版本机械复制一个 Adapter。

```text
DSH 0.1.2-alpha.1 ┐
                  ├─ 原生格式与生命周期兼容 → dsh-alpha2 Adapter
DSH 0.1.2-alpha.2 ┘

未来格式发生破坏性变化 → 新建并人工审核 dsh-next Adapter
```

首版只实现 `dsh-alpha2`。格式观测器可以辅助收集 fixture 和生成差异报告，但不能自动生成或自动启用 Adapter。

## 11. 启动差量投影

本地投影可以保留，但每次启动必须向 Maintenance 拉取“上次已应用 Revision 之后”的变更，而不是扫描全部会话正文：

```text
lastAppliedRevision = 20500
Maintenance currentRevision = 20509
                 │
                 └─ listChanges(after=20500)
                    → 只返回 9 条变更涉及的会话 ID
```

Adapter 只重投影发生变化的会话；未变化会话文件不读取、不改写。运行期间新增事件仍先取得 Maintenance durable receipt，再确认本地写入。该策略称为“启动差量投影”，不改变 Maintenance 的唯一真源地位。

第一段已实现为 Schema v12 的 `canonical_change_log` 和
`CanonicalSessionRepository.listChanges({ afterRevision, limit })`。日志只保存
Revision、逻辑会话 ID、变化类别和时间；Projection Lifecycle 接入持久缓存由
后续 M04/M05 完成。

## 12. 第一版验收断点

只保留高价值断点，并给每个断点提供状态日志入口：

1. `canonical.normalize`：来源事件被分类为公共语义或 `other`；
2. `adapter.evidence`：只记录 Adapter、证据摘要、数量和成功/失败，不记录 payload；
3. `adapter.materialize`：`other` 生成 `maintenance/other`；
4. `projection.surface-audit`：`other` 没有 `surfaceOp`，也没有 `tool/result`；
5. `client.card`：DSH UI 能显示折叠维护卡片；
6. `model-history.audit`：派生请求中不存在 `other` 内容；
7. `legacy.read`：旧 `opaque-unknown` 仍能读取。

只有某个断点失败时，才在相邻断点之间增加更细日志与测试。

## 13. 第一版暂不做

- 不实现第三方 Harness Adapter；
- 不自动猜测或生成 Adapter；
- 不把历史 `rawPayload` 一次性迁出 Canonical Store；
- 不重写 Launcher 生命周期；
- 不对真实 Codex 或 DSH Home 做写入验收；
- 不把 UI 工具卡片冒充模型工具结果。
