---
id: MOD-business-pages
kind: module
title: 公开业务信息页与贡献者生命周期
status: current
relations:
- relation: provides
  to:
    record_id: IF-extension-pages
- relation: consumes
  to:
    record_id: IF-extension
---

# 公开业务信息页与贡献者生命周期

业务插件贡献结构化信息页，Maintenance 汇总完整名单；业务动作由各贡献方执行，信息页服务不接管插件数据或配对真源。每个贡献带 instance/profile/namespace/provider/boot 身份、单调快照 revision 和声明的 action/fields。

Engine BusinessPageRegistry 持久保存页面快照和 operationId 回执，按 owner/boot 隔离 register/heartbeat/poll/ack/unregister；旧 boot 不覆盖仍活跃提供方。Engine 重启后未完成动作标 uncertain，不自动再执行。host maintenanceBusinessPages 保管 Engine token，为自身贡献轮询并在 ack 响应丢失后复用执行结果；可选服务缺席不阻断其他业务。

Dashboard 使用通用摘要、状态、键值、目录入口和声明动作表单；提供方接口仅允许受信 host bearer，浏览器动作仍通过共同 session/origin/CSRF 入口。输入不可承载任意 HTML 或脚本。

提供方源码合同：packages/contracts/src/business-pages.ts；Engine apps/engine/src/business-pages.ts 与 http/business-page-routes.ts；host plugins/dsh-session-maintenance/src/business-pages.ts。Bridge 是新增贡献者，绑定操作仍交 Companion CAS 确认；业务目录继续复用既有 Adapter，不与页面能力混成同一写权限。当前 UI 提交丢响应的幂等重试修复及最终验收见 [[VER-scope-business-pages]]。
