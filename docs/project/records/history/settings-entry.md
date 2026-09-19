---
id: HIST-settings-entry
kind: history
title: DSH 设置面板收敛到完整看板入口
date: 2026-09-19
status: current
modules: [宿主接入]
summary: 根据用户截图移除旧维护偏好及操作，仅保留完整看板入口，并通过宿主前端热更新交付。
outcome: 源码、测试与安装前端已更新；实际HTTP新脚本通过，合成视觉通过，安装版设置视觉未验收。
applicability: .32前端源码覆盖已安装.29客户端；Engine .46及Dashboard .1.9不变。
coverage_note: 本任务1795至1934行公开来源索引，原始载荷留在宿主。
history:
  path: history/settings-entry-20260919
  sha256: cab71e42c8befa2893809213fb9df05bcec0123a8a7212076205bbe9378082c2
  capture_sha256: f97cfba33fa1cced3f7cfca6838e9bbbb5cf78110229564b17184b962d99174d
related_records: [REQ-sync-extension-navigation]
---

# DSH 设置面板收敛到完整看板入口

用户截图指出旧设置页仍有无关的保存、扫描、同步、重读按钮，明确只保留完整看板。删除配套偏好表单及挂载读取，保留全局登录打开逻辑；不删除完整看板或后端能力。

源码发现工具提示未绑定工作区，改用已知Git范围内检索，找到settings.section注册组件及全局看板测试。原测试保留正式全局打开行为，补核对只渲染一个按钮且渲染不发请求；7项测试、类型检查和构建通过。

因实例正在运行，检查宿主client-modules与client-hmr源码确认官方前端热更新机制。首次HTTP脚本发现只查script标签，未覆盖应用脚本preload，因此在任何安装写入前拒绝；改为按真实script/link加载图查找后完成。备份客户端文件与受保护配置，再原子替换唯一客户端资源；正式HTTP已取得新版入口、实例bootId不变。

外部浏览器句柄不可用；以实际组件合成页面检查单按钮布局，不能将其当成完整安装版设置视觉验收。详见[变更报告](../../../changes/2026-09-19-settings-dashboard-entry.md)。
