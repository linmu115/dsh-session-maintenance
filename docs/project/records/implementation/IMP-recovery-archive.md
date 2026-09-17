---
id: IMP-recovery-archive
kind: implementation
title: 纯准备尾部恢复与宿主归档还原
status: current
summary: 新扫描的配置尾部不派生会话；启动通过官方归档接口还原 canonical 归档。
---

# 纯准备尾部恢复与宿主归档还原

DSH 0.1.5 Adapter 0.1.4 在验证原生头和已提交前缀后，忽略仅包含 end-seed、permission、sandbox、approval 的恢复尾部；混合真实事件完整提交。此过滤补齐已存在的 WAL 恢复过滤。归档时间进入投影目录，宿主接入以官方 archiveSession 还原正向归档意图；没有归档标记不会撤销用户的宿主归档。

旧派生历史的无标题问题采用官方重命名追加，不重新排列已有消息。2026-09-17 已部署到 RC2 副本 / web，并完成第二次重启验收：无新增会话身份，四份纯准备重复项保持归档，标题与原始前缀保留；原始镜像唯一可见。诊断、用户授权、开发历程及部署验收见 [本次报告](../../../reports/2026-09-17-recovery-archive-title.md)。
