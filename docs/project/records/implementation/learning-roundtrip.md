---
id: IMP-learning-roundtrip
kind: implementation
title: 学习双向维护首版与使用边界
status: current
progress: implemented
gap: .46 现网已含实验入口，.47 等待修复包未激活；真实绑定与原队列阻塞触发方未验收，跨 DSH 实例重选未实现。
summary: 同一会话显式绑定与受控回收；.47 补齐排队取消、请求超时和候选阻塞提示，包已验证但未激活。
relations:
- relation: implements
  to:
    record_id: REQ-learning-roundtrip
---

# 学习双向维护首版与使用边界

2026-09-19 当前状态：现网 .46 已包含实验入口，以下“尚未部署”是 09-17 首版时点。首次关联持续等待的修复包 .47 / Dashboard .10 已构建并完成隔离测试，尚未激活；写路径等待已复现，队列最初占用方仍待定位。见 [本轮排查与验收](../../../reports/2026-09-19-learning-bind-wait.md)。

完整看板新增“学习双向维护”栏目。只有用户确认的现有 Codex 来源与 DSH 投影能加入；核对共同问答前缀后，Maintenance 接管原逻辑身份。普通 Codex 扫描跳过这条绑定的正文与项目重新分配，DSH 正常续写不派生新分支。停用关联保留主线和历史，不回退到旧镜像覆盖规则。

“同步到 Codex”只注入缺少的问答及已识别的原生引用文本快照。“回收 Codex 会话”只追加成功交接边界后的完整问答。新增 native V3 尾部，原 canonical 事件前缀与扩展锚点不被重建。思维图、Obsidian 关系等扩展对象不送到 Codex。

Engine 统一写队列；schema 25 保存绑定、仅含摘要的消息边界及交接回执。正文仍由原版本库维护。正文变动、归档、删除会增加单调修订号；只改标题而正文对象未变不会触发正文锁。读取检查 Codex 原始日志前缀摘要、轮次开始/完成时间；提交前再次核验，正文推进和回执消费处于同一事务。回收失败不会留下半次正文推进。状态不明先“核验同步结果”，不盲目重发。

现阶段操作顺序：正常停止对应 DSH 实例 → 在完整看板核对并加入 → 同步到 Codex → 重新启动 Codex 并在原任务继续学习 → 回到 Maintenance 回收 → 重新启动 DSH 继续原会话。交接控制操作不触发模型；实际学习回答按原 Codex 设置运行。

## 限制与部署状态

2026-09-19 后续部署：Engine .49 / Dashboard .10 已激活，包含关联排队期限、请求期限、运行状态预检、空继承分支恢复及历史隔离范围修复。本次停止已正式恢复，34 个候选运行阻塞清零；真实学习绑定仍为 0。下述首版未发布结论仅表示 9 月 17 日时点，最终证据见 [本轮报告](../../../reports/2026-09-19-learning-bind-wait.md)。

- 当前只验证 DSH 0.1.5-rc.2 与 Codex CLI 0.153.4 的 legacy 历史；其他版本或历史格式拒绝。
- 不能把注入内容实时推入已运行桌面的内存；重启加载是首版约束。Codex 逐条呈现导入历史未实现，也不作为本轮通过项。
- DSH 活动实例、未完成恢复作业、两端问答分歧会阻止交接。不能控制 Codex 前端输入；回收前须等回答结束，期间不要继续输入。
- 非文本材料、DSH 上下文替换、Codex 回滚/压缩或新增工具调用会阻断。引用快照仅覆盖已有可识别的 nativeContext 文本及正文中的引用，无法恢复之前已丢弃的引用正文。
- 既有问答必须是精确共同前缀；不会自动合并不一致的历史。摘要/分页索引不能冒充完整材料。
- 迁移继续使用同一 Maintenance 数据库和版本库。Codex 路径变化、DSH 原生端点变化需显式重新核对，旧交接作废；跨 DSH 实例重新选择绑定端点尚未实现。
- 本轮未发布安装包，未改变真实绑定、正文或运行实例。只读核对的“机试DeepLearning”仍是 Codex 镜像，目标 DSH 实例当时正在运行。

实现：apps/engine/src/learning-service.ts、packages/adapter-codex-continuation/src/learning.ts、packages/adapter-dsh-0-1-5/src/learning.ts、apps/dashboard/src/learning-page.tsx。验证见 [[VER-learning-roundtrip]]，过程见 [[HIST-learning-roundtrip-implementation]]。
