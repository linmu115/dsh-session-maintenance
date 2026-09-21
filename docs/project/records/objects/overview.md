---
id: OBJ-session
kind: object
title: 逻辑会话与工作区身份
status: current
summary: 长期逻辑身份连接规范历史、原生映射与工作区；运行目录不能代替会话身份。
sources:
- path: ../../README.md
- path: ../../packages/contracts/src/canonical.ts
- path: ../../packages/canonical-session-engine/src/dsh-append.ts
---

# 逻辑会话与工作区身份

会话在工作区中长期存在，logicalSessionId 是跨平台关联入口。原生 session ID 只在相应实例和格式内有效；runId 标识一次运行。会话移动后，扩展目录沿当前工作区成员关系更新，不重写扩展正文。

| 身份 | 用途 | 负责方 |
| --- | --- | --- |
| logicalSessionId | 同一个长期会话 | Engine 及规范存储 |
| sourceVersionId / versionId | 引用或恢复的历史版本 | [[OBJ-version]] |
| nativeSessionId 与运行映射 | 当前宿主怎样找到会话 | [[MOD-harness]]、[[MOD-runtime]] |
| logicalWorkspaceId / membership | 当前工作区归属 | Engine 工作区目录 |

Codex 来源由 Codex 管理，Maintenance 只读导入为镜像。仅显示或引用镜像不会派生会话；首次向其 DSH 投影实际追加，由 Engine 创建 Maintenance 所有的派生身份。来源更新推进镜像，既有引用仍固定原版本，派生内容不被覆盖。

待实现的显式学习双端绑定模式 [[REQ-learning-roundtrip]] 将限定例外：两端受控追加推进同一逻辑身份，DSH 续写不派生，绑定 Codex 不另建镜像。当前默认镜像行为尚未改变，不能把此需求解释为已上线能力。

唯一共享定义在 [Canonical 类型](../../../../packages/contracts/src/canonical.ts)；实现依据 [追加与派生](../../../../packages/canonical-session-engine/src/dsh-append.ts)。运行空间见 [[OBJ-runtime]]，业务对象见 [[OBJ-extension]]。

2026-09-21 用户注释新增的写入权边界（尚未实现）：来自 DSH 侧的引擎真源改动**只**依赖**已绑定**实例在**同步工作区**内产生的会话改动；实例自带工作区是该实例的自有工作区，其中的会话不进入真源也不被覆盖。工作区经右键菜单「将当前工作区加入 sessionmaintenance」显式加入。见 [[DEC-directory-connect-sync-authority]]。
