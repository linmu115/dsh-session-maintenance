---
{
  "id": "INT-gpt-format",
  "kind": "implementation",
  "title": "GPT 插件的独立会话格式 Adapter",
  "status": "current",
  "summary": "独立身份、事件校验与实例路由已实现；旧部署的全局重打包不能作为正式接入。",
  "module_id": "MOD-harness-dsh",
  "relations": [
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-harness-adapter"
      }
    }
  ],
  "sources": [
    {
      "path": "../../packages/adapter-dsh-gpt-compat/src/index.ts"
    },
    {
      "path": "../../packages/adapter-dsh-gpt-compat/src/codec.ts"
    },
    {
      "path": "../../apps/engine/src/integrations/launcher-discovery.ts"
    }
  ]
}
---

# GPT 插件的独立会话格式 Adapter

包 `@linmu/dsh-session-adapter-gpt-compat`，Adapter ID `dsh-gpt-compat`，格式 `dsh-gpt-compat-v1-jsonl-zstd`。能力 `dsh-gpt-compat/session-v1`；当前限定 DSH 0.1.5-rc.2 与插件 0.5.0-dev.N（N≥1），实际构件另需哈希回执。

五个必需事件由插件 codec 负责：context/checkpoint、context/checkpoint-commit、context/operation、context/operation-result、request/projection。原始 JSON、不透明加密内容、序号及引用完整保留；非法引用、未来未知事件和错误格式身份拒绝。普通 dsh-0.1.5 保持官方事件词表。

共同 V3 物化、追加、压缩文件、原生证据和恢复机制通过每次调用的独立上下文复用；不替换全局导入。Engine 注册独立 worker，Launcher 从启用的 bundle 与构件回执选择，Broker 和 Core 绑定沿同一身份执行。

普通旧回执仍属于普通 V3。GPT 格式 Core 回执需显式 sessionFormat；格式身份更改会使用不同 native-space 键。现有副本之前为联调而做的全局重新打包不是本 Adapter 的部署证据；本次完成源码、合成验证和发布接线，运行副本升级应停机、备份并重新验收绑定。

规则以 [[IF-harness-adapter]] 为准，测试与报告见 docs/reports/2026-09-17-gpt-format-adapter.md。
