---
id: REQ-sync-extension-navigation
kind: requirement
title: Maintenance 与 Codex 同步并列，扩展页由插件贡献
status: current
summary: 同步页并列显示 Maintenance 工作区同步和 Codex 项目同步；扩展页先选适配器，再显示其实际注册的子栏目。
---
同步页的两种同步是平级入口，各保有自身范围权威。扩展页先选业务适配器，再进入该适配器实际注册的“扩展数据”或信息页；不能因公共页面 API 存在而给所有插件伪造栏目。切换子页应保持未保存草稿和未完成回执，选中状态清楚，正文占用内容区域。

DSH 设置页的会话维护面板只保留“打开完整看板”；旧维护偏好和手动扫描/保存/重读操作不应重新出现。读目录失败显示可重试错误，不以实例在线状态替代目录可用性。代码入口见 [[MOD-ui]]、[[MOD-business-pages]]；视觉和真实交互未由源码检查证明。旧来源：`d3fdbe3:docs/project/records/requirement/sync-extension-navigation.md`。
