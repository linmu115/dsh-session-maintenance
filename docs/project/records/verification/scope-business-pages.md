---
id: VER-scope-business-pages
kind: verification
title: 工作区范围与公共信息页的本地验收
status: current
relations:
- relation: verifies
  to:
    record_id: IMP-scope-business-pages
- relation: verifies
  to:
    record_id: MOD-instance-workspace
- relation: verifies
  to:
    record_id: MOD-business-pages
---

# 工作区范围与公共信息页的本地验收

2026-09-18 根代理汇总的合成验证，分组可能交叠，不相加为总测试数。

| 验证组 | 已通过 | 边界 |
| --- | --- | --- |
| store + projection-lifecycle + runtime-broker + instance-workspace-runtime | 44 文件、164 tests | 分类策略、运行快照、投影/缓存和提交防护；当前工作树 |
| actual HTTP composition 新路由 + 原 http-api | 2 文件、4 tests | Engine 实际 HTTP 接线 |
| host instance-workspace/session-knowledge + cache focused | 11 tests | 宿主身份/范围与聚焦缓存 |
| UI/API 前阶段 | 34 tests | 对应 scope 代理前阶段回执 |
| 新 business pages | 20 tests，五包类型检查与插件构建 | 含提交丢失后的幂等重试及正式公开类型消费 |
| 全 Dashboard + host | 48 文件、195 tests（73 + 122） | 实际 Cordis 晚注册、卸载停止重试、无消费者零请求 |
| 新候选知识组合 | 集成用例通过 | 贴纸迁移、部分删除目标、陈旧 CAS、拒绝改投与引用隔离 |

独立只读审查：cache 原配置保留 instance/profile/branch，scopeRevision 参与 digest；run 策略持久冻结；Canonical commit 事务内重新查成员/删除状态。页面 owner 带 boot、旧 boot 不能覆盖在线页，host 缓存支持 ack 丢失重放，Engine 重启未完成动作转 uncertain。

独立审查 P2 已闭合：提交请求在发送前持有完整请求与 operationId，响应丢失后的重试沿用同一 ID；未确认终态不会自动新建动作。提供方 TTL 到期显示离线与结果待核验，不自动重执行。正式 DTO 的跨仓页面验证另发现多 Vault 快照超限，Bridge 已收紧展示预算并通过 45 个合法长身份的边界用例。

实现提交：策略 eb7e9fa、配置界面 0c8efca、公开页 b32c594、宿主验收 7dc2067、运行范围与接线 d3695f6。候选 Engine 0.1.33-rc2.38、维护插件 0.2.26-rc2.29。Engine、Contracts、Store、Projection Lifecycle、Local Client、Dashboard 与宿主插件构建通过，构建后 Engine 可导入。未部署真实实例、未改用户数据、未做真实窗口视觉验收。各组可能交叠，不加总为整体唯一测试数；公共动作回执容量为 2000，满后拒绝新动作且不丢弃幂等证据。
