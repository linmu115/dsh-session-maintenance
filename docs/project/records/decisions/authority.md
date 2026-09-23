---
id: DEC-authority
kind: decision
title: 规范真源与分层责任
status: current
summary: Maintenance 持有逻辑会话和版本真源；宿主拥有原生会话，插件拥有其业务数据语义，适配器负责格式和物理投放。
---
规范事实与端点物理状态分开：真源保留稳定身份、版本、工作区、回执及不透明插件原值；DSH/Codex 宿主控制自己的运行和原生格式；插件适配器解释并恢复其专属数据。用户已明确 Maintenance 本体不耦合实例、Launcher 或具体插件，具体耦合只允许发生在 adapter；当前实现尚有 [[ISS-remaining-coupling]]。本决定继承旧规格中稳定真源、可换 codec、租约/WAL/回执与持久空间原则，但被后续同步范围和插件原值要求收窄。旧依据：`d3fdbe3:docs/project/records/decision/authority-history.md`。
