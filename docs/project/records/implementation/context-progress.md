---
{
  "id": "IMP-context-progress",
  "kind": "implementation",
  "title": "长历史发送预览与压缩进度",
  "status": "current",
  "modules": [
    "运行时投影与兼容校验"
  ]
}
---

验收：先展示待发送输入；显示真实压缩段数与等待时间；失败保留原因和草稿；正式提交不重复消息；保持当前引用原文及并行迁移接口。

为保持新 GPT 插件的启动资格，extension-gpt-compat 的精确版本名单新增 0.5.0-dev.7，未知版本仍拒绝。Engine 升为 0.1.33-rc2.36，重新构建主引擎、独立格式 worker 与绑定工厂，刷新构件回执并通过正式 repair 更新实例绑定。插件保持 0.2.26-rc2.28。没有修改会话格式、恢复或派生算法。

[开发历程与验证边界](../history/context-progress.md)。
