---
{
  "id": "DEC-selection",
  "kind": "decision",
  "title": "这张地图选了哪些资料",
  "status": "current",
  "summary": "原需求和合同保留，目录按责任组织，历史报告仅证明当时范围。",
  "sources": []
}
---

# 这张地图选了哪些资料

Session Maintenance 是独立项目，沿用 ID `0d05f813-7097-47d9-9e88-3d523bb537d6`。Suite 与 ThoughtDAG 是外部协作者；配套版本、包依赖或同仓库不证明项目成员资格和运行启用。

当前 README、正式规格、contracts 与关键调用点共同解释现状。Harness 平台适配和业务扩展适配分支独立；有独立接口/对象/生命周期时继续拆子模块，不复制函数目录。

原文按精确标题绑定。接口先解释交接和失败，再链接唯一技术定义；消费者只说明具体调用。实现与验证独立，旧回执不升级为本轮复测。

既有记录 ID 保留；IF-extension、IF-graph、IF-native-context、OBJ-session 移到责任目录，图映射同步，历史位置由 Git 保留。首次采用基线留 source-baseline.json 的 history，当前提交/源摘要另记。

规格后继 [[DEC-authority]]；A/B 共用地图。外部仅保留项目/条目 ID 和短说明，不导入全图。本次普通维护不新增 kind:update，不开发产品功能或执行 LLM 成本基准。
