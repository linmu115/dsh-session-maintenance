---
{
  "id": "IMP-reference-identity-recovery",
  "kind": "implementation",
  "title": "重启后引用身份恢复与旧链接定位",
  "status": "current",
  "modules": [
    "运行时投影与兼容校验"
  ]
}
---

需求与验收：恢复原有引用及旧链接，重启后继续有效；保留原文、明确删除状态和实例隔离。

稳定引用解析先检查原会话锚点；若失效，仅在当前实例、配置与运行中检查可见派生后代，通过适配器逐一验证目标消息。只有唯一命中才改指向；多命中、超过 32 个候选、已归档或不可见会话均不猜测。引用目录新增可选 targetMessageId，由 Core 提供持久消息证据。同步时核实实际接收会话，事务内退役错误归属的旧目录条目并保存正确条目；同内容的较低来源修订可幂等确认，不允许不同内容覆盖。

实现：apps/engine/src/derived-reference.ts、engine.ts、extensions/annotation-sync.ts 与 contracts/extension-directory.ts。同步更新引擎/插件兼容名单与构件资格验证。核心文本恢复由 Annotation Core 提供，Maintenance 不解析其私有存储。

[开发历程与真实验证](../history/reference-identity-recovery.md)。
