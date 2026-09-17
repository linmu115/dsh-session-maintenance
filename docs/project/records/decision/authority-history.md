---
id: DEC-authority
kind: decision
title: 真源原则和后续规格怎样继承
status: current
summary: 稳定真源保留，持久空间、每会话主干、归属与原生上下文由后续规格限定。
sources:
- path: ../superpowers/specs/2026-08-31-session-maintenance-canonical-projection-design.md
- path: ../superpowers/specs/2026-09-03-maintenance-canonical-session-format-v1.md
- path: ../superpowers/specs/2026-09-10-persistent-native-session-space.md
- path: ../superpowers/specs/2026-09-10-pluggable-extension-data-requirements.md
- path: ../changes/2026-09-14-session-main-graph-spec-revision.md
- path: ../superpowers/specs/2026-09-15-extension-ownership-and-session-reader.md
- path: ../superpowers/specs/2026-09-15-native-agent-context-management.md
---

# 真源原则和后续规格怎样继承

| 来源 | 保留的认识 | 后继边界 |
| --- | --- | --- |
| [08-31 稳定真源](../../../superpowers/specs/2026-08-31-session-maintenance-canonical-projection-design.md) | Canonical、可换 codec、租约/WAL/回执、延迟派生 | 临时空间寿命由持久空间修订，不整篇退役 |
| [09-03 MCSF v1](../../../superpowers/specs/2026-09-03-maintenance-canonical-session-format-v1.md) | 共享语义与模型暴露；未知语义保留 evidence | V3 原生转换由当前 0.1.5 Adapter 说明 |
| [09-10 持久空间](../../../superpowers/specs/2026-09-10-persistent-native-session-space.md) | 正常关闭复用原生空间，恢复尾部再同步 | 原 RC1 验证保留，当前 RC2 实现另查 |
| [09-10 扩展数据](../../../superpowers/specs/2026-09-10-pluggable-extension-data-requirements.md) | 独立 namespace/schema/writer/冲突 | 面板与归属以 09-15 修订为准 |
| [09-14 主干修订](../../../changes/2026-09-14-session-main-graph-spec-revision.md) | 接收会话主干、延迟绑定、统一撤销、轻量日志 | 全局网络、纯知识线、批量重答移出确认范围 |
| [09-15 归属与阅读](../../../superpowers/specs/2026-09-15-extension-ownership-and-session-reader.md) | 业务面板、单所属会话、Core 只读镜像和按需过程 | namespace/兼容版本查当前代码 |
| [09-15 原生上下文](../../../superpowers/specs/2026-09-15-native-agent-context-management.md) | 授权/窗口/保留、意图与实际替代证据 | 仅原生 Agent，托管内部释放不在范围 |

历史保留原身份、章节与验证版本。这里没有删除代码、将已存在功能记成失败探索，或把已撤销功能重新列为待办。
