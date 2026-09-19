---
id: REQ-sync-extension-navigation
kind: requirement
title: 两类同步并列与插件内信息页层级
status: current
progress: implemented
summary: Maintenance分类范围与Codex项目名单分别管理；扩展先按插件，再展示该插件的数据与信息页。
relations:
- relation: derived_from
  to:
    record_id: REQ-extension-pages
- relation: derived_from
  to:
    record_id: HIST-extension-pages-vault-binding
sources:
- path: ../changes/2026-09-18-extension-navigation-hierarchy.md
- path: ../changes/2026-09-18-sync-sections-and-current-scopes.md
---

# 两类同步并列与插件内信息页层级

2026-09-18用户纠正了两个层级：全局入口叫“扩展”，其内先选业务插件，Obsidian系列内再并列“扩展数据”和“插件信息与接入”；同步入口内则并列“Maintenance工作区同步”和“Codex项目同步”，不能把完整表单上下挤在一起。原消息定位保存在 [[HIST-extension-pages-vault-binding]]。

Maintenance选择的是自身逻辑分类工作区及未分组会话，不是DSH文件夹项目；每稳定实例共享策略，所有profile和绑定Vault服从同一实例范围，当前run保留各自启动快照。保存新选择只在下次实例启动生效，当前运行和历史链接不会因为取消选择而被删除。Codex按自身项目会话目录维护另一份映射名单，两者不能竞争同一范围权威。

验收需看到并列入口、明确选中状态、只展示当前子页、切换保留未保存选择且不发保存请求。扩展分类从注册元数据形成，插件页面不得跑到其他插件内；信息页与业务数据操作保留各自身份和权限。当前实现 [[IMP-sync-ui-release]]；实际检查范围 [[VER-sync-ui-release]]。


## 2026-09-18 再次验收后的明确修订

每个Adapter固定维护“扩展数据”页；其他子页必须由该Adapter或其业务提供方实际注册，Maintenance不得因公共信息页API存在就给所有Adapter生成“插件信息与接入”。本次现有注册中仅Obsidian拥有该信息页，GPT兼容插件和ThoughtDAG只显示数据页；未来自定义提供方注册的页面按自身标题及namespace/provider身份生成子栏目，多实例归入同一栏目。

扩展的Adapter选择位于内容顶部一级导航，Adapter内部子目录紧随其后；同步的Maintenance/Codex位于内容顶部同级导航。均使用平直文字与选中底线，不使用气泡/圆角分段按钮。正文位于导航之外，占用整块内容区域，切换的是整页正文；不得把完整子页嵌在大卡片方框内切换。已有选择、未保存草稿和未完成操作回执跨子栏目切换保留。

2026-09-19 目录加载失败反馈：已保存扩展工作区不依赖 DSH 实例在线；读取失败须显示可重试的失败状态，右侧不得继续引导用户展开不存在的目录。HTTP 431 与实例运行状态分别诊断。
