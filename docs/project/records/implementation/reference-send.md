---
{
  "id": "IMP-reference-send",
  "kind": "implementation",
  "title": "模型设置误触发派生会话修复",
  "status": "current",
  "modules": [
    "运行时投影与兼容校验"
  ]
}
---

运行时 projection-runtime.ts 与 V3 native-session-codec.ts 同时将 model/selection 视为准备事件。新版本名单、引擎及插件构件验证同步更新。

需求：先压缩旧历史，再原样注入本次引用与正文；不因单纯设置操作新增会话。

[开发过程、测试与部署边界](../history/reference-send.md)。

当前边界以请求中本次用户消息 ID 为准，避免把已完成旧轮次当作草稿保护。准备阶段还包含四类内部上下文事件；这些事件本身不触发派生。版本与真实验证状态见开发历程。
