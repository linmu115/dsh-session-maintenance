---
{
  "id": "INT-gpt-format",
  "kind": "implementation",
  "title": "GPT 兼容插件的扩展数据 Adapter",
  "status": "current",
  "summary": "保留 DSH Harness 身份；GPT 扩展拥有事件解析、只读索引和独立业务面板。",
  "relations": [
    {
      "relation": "consumes",
      "to": {
        "record_id": "IF-extension"
      }
    }
  ],
  "sources": [
    {
      "path": "../../packages/extension-gpt-compat/src/extension.ts"
    },
    {
      "path": "../../packages/extension-gpt-compat/src/codec.ts"
    },
    {
      "path": "../../apps/engine/src/extensions/gpt-sync.ts"
    }
  ]
}
---

# GPT 兼容插件的扩展数据 Adapter

包 `@linmu/dsh-session-extension-gpt-compat` 属于扩展数据；namespace 和业务面板 ID 都是 `gpt-compat`，writer 为 `maintenance-gpt-compat-index`。本轮支持插件 0.5.0-dev.1/.2/.3，版本以代码白名单为准。

宿主继续使用 `dsh-0.1.5` Harness 和 `dsh-0.1.5-v3-jsonl-zstd-v1` framing；GPT 不是 Harness，不能注册为高级设置中的平台 Adapter。受信扩展解析器与宿主 codec 组合，普通底层解码器和全局依赖不被修改。

五类扩展事件由本插件 Adapter 校验：context/checkpoint、context/checkpoint-commit、context/operation、context/operation-result、request/projection。原始 JSON、加密载荷、序号和引用随 Canonical/原生会话完整保存。新 Canonical 事件保留宿主 adapterId，另记 extensionNamespace。非法引用和未来未知事件仍拒绝。

Engine 从已提交会话版本建立只读摘要索引，按实例/Profile/会话归属显示检查点、两类压缩和请求投影数量。正文不复制密文；刷新相同来源版本不产生新修订。扩展的通用写入、删除和恢复能力关闭，原始状态只由会话链路维护。

Launcher 验证插件版本、能力与构件哈希后，向插件报告原生扩展连接；该报告与其他业务插件配置合并。停用保留索引，不能靠更改 Harness ID 表示插件开启。Core 回执为原 DSH adapter/format，另有 `sessionFormat.extensions: ["gpt-compat"]`。

历史误建的 `dsh-gpt-compat` 事件身份和旧 run 审计保留，兼容读取后通过 Canonical 正常物化。新引擎不注册该 Harness，旧运行须先由旧版本正常收尾。不得就地改写运行中的回执、历史事件或缓存归属。当前配套源码为 Engine 0.1.33-rc2.30 / 插件 0.2.26-rc2.24；副本已经按该组合启动并通过实际 API、Core 绑定和历史恢复验收；当前 1 个会话索引含 5 次请求投影，详细结果见本轮报告。

合同 [[IF-extension]]；此次误解和纠正见 [[HIST-gpt-extension-boundary]]。早期独立 Harness 实现与通过的工具测试属于历史尝试，不能作为当前职责设计的依据。
