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
