# 用户请求索引与原生上下文看板

日期：2026-09-15。范围：Dashboard 与本地客户端。运行副本发布、Engine 范围核验和原生材料释放由联合交付单独验收。

阅读器新增默认折叠的“用户请求索引”。只有展开后调用 canonical 会话 requests 目录，支持目录翻页和超长请求分段，页面替换而非不断积累正文。收起和切换会话取消在途读取，过期游标提供重新加载第一页。真实提交、执行中补充、可信来源与未确认关联分别展示；执行已结束不解释成需求解决。系统/技能/引用材料的分类仍由共享 Adapter 决定，前端不按自然语言猜测。

扩展数据的 `annotation-context` 由 Obsidian 系列 Adapter 归属当前接收会话，不创建新的业务面板。详情使用共享 `NativeContextState`，分开展示固定授权、活动窗口、实际保留、用户/模型固定、待生效与最终回执。共享材料被某引用放弃持有、仍由别的引用保留时明确说明。详情只读，即便通过旧版扩展目录进入也不能用通用 JSON 编辑绕过业务服务。操作入口指向所属会话的思维图。

请求索引属于会话阅读查询，不在每图复制请求或全文。历史披露记录仍附属 ThoughtDAG 主干，已释放不改成“从未读过”。

验证：Dashboard/客户端类型检查；用户目录的懒加载、长文分页、收起取消、过期游标恢复；上下文三层状态与 pending 回执区分；原有 reader/扩展目录回归；Dashboard 客户端使用 cookie/CSRF 请求稳定消息目录且不携带 Engine bearer。

代码入口：`apps/dashboard/src/user-request-index.tsx`、`native-context-detail.tsx`、`session-workbench.tsx`、`extension-page.tsx`、`packages/local-api-client/src/client.ts`。这些 UI 测试不替代真实原生 surface 释放验证。
