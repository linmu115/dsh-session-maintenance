---
id: REQ-offline-vault-binding
kind: requirement
title: 按已登记实例管理独立 Vault 绑定
status: current
summary: Vault 绑定需显示目标实例身份与当前状态，独立于会话同步范围，不能因日常只读检查被修改。
---
Maintenance 的 Vault 绑定页面以已登记实例为对象，支持选择、文件夹绑定、逐行解绑和状态核对；不能仅凭显示名称或历史端口识别目标。绑定与会话真源、同步选择、插件数据投放是不同权威，界面需明确区分。

2026-09-19 的界面修订要求保留原流程并优化列表列宽、弹窗留白和操作层级。当前实现入口见 [[MOD-vault]]；真实 UI 效果须在浏览器单独验收。旧来源：`d3fdbe3:docs/project/records/requirement/offline-vault-binding.md`。
