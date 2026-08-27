# P19：会话版本工作台、三方差异、计划与 Checkpoint

## 结果

- 会话卡片现在进入统一版本工作台：左侧为可横向调整的 GitGraph，右侧局部页签依次展示介绍、版本正文、三方差异和操作。
- GitGraph 使用确定性拓扑/泳道算法，支持线性、分叉和双父节点；同一输入在乱序后仍生成相同布局。
- 概览页不加载图；进入会话后只加载首个图分页、绑定和 Checkpoint 摘要；点击节点后才读取正文，点击比较后才读取 source/base/target 正文与 diff。
- 版本正文按事件展示并使用安全 Markdown；图分页可继续加载，左栏在窄窗口自动转为可纵向调整。
- 三方差异明确区分来源、共同基线和目标，不把分叉历史伪装为一条时间线。
- 计划预览显示 immutable plan ID、风险、操作和确认项；只有无确认的 `safe` 计划开放“应用安全计划”，review/destructive 失败关闭。
- Checkpoint 编辑器把当前版本引用、名称和 Markdown 说明提交到既有 Engine 服务，不复制会话正文。
- 新增计划摘要分页 API/Client，Dashboard 顶层增加计划与 Checkpoint 入口；计划完整内容只在选中后读取。
- Dashboard 将工作台、计划页和 Markdown 拆成懒加载 chunks，首屏 JS 保持约 275 kB（gzip 约 84 kB）。

## 安全边界

- 所有操作继续通过 cookie-authenticated typed client；没有引入路径、bearer、文件读写或第二套事务状态机。
- 计划应用仍由 P14–P16 Engine/JobStore 决定；UI 只解释返回的风险和提交 plan ID。
- 本阶段只使用合成测试数据，没有读写正式 DSH/Codex home。

## 精简验证

- GitGraph、安全 Markdown、workbench lazy/risk、plan-store 分页、operation API：5 文件 / 8 tests 通过。
- contracts、session-store、local-api-client、engine、session-ui、Dashboard 定向 typecheck 通过。
- Vite production build 通过；workbench、catalog 和 Markdown 均为独立按需 chunk。
