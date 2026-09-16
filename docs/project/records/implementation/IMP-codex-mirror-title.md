---
id: IMP-codex-mirror-title
kind: implementation
title: Codex 镜像标题的原生冷读取
status: current
summary: Adapter 0.1.3 将镜像名称物化为 DSH 标题事件，避免冷读取后丢失目录缓存名称。
---

# Codex 镜像标题的原生冷读取

Codex 名称不能只存在于 Maintenance 目录及启动缓存。DSH 0.1.5 Adapter 为 Codex portable 投影生成 session/title，在消息投影之后记录名称，使原生日志可独立恢复标题。原 Codex 行和消息锚点保持不变；旧派生尾部不移动，新派生保留标题槽位，后续 DSH 原生重命名优先。

Adapter 0.1.3 通过缓存指纹触发旧镜像重物化；源码提交不等于运行副本已升级。用户来源、要求、实现及合成验证范围见 [修复报告](../../../reports/2026-09-16-codex-mirror-native-title.md)。

2026-09-16 用户追加授权后，已将修复构件部署到 `0.1.5-rc.2 副本 / web` 并通过 Launcher 重启。真实原生文件和官方会话列表均恢复“机试DeepLearning”，六个扩展命名空间就绪。配套外层包版本未变，精确构建身份、摘要及验证边界见修复报告的后续部署章节。
