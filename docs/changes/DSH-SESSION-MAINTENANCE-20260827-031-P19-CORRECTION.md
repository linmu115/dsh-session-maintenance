# P19 纠错：大版本树虚拟化与 Checkpoint 恢复预览

## 原问题

- 初版 GitGraph 虽然按页读取，但会把当前页全部节点、边和按钮同时放入 DOM；1000 节点历史会造成不必要的渲染与键盘操作缺口。
- Checkpoint 页面只展示命名恢复点，没有把“建立恢复点”和“从恢复点生成新分支计划”分成两个入口。

## 修复

- GitGraph 使用固定行高、真实 scroll viewport、ResizeObserver 和 overscan window；DOM 只保留可视行及其相邻边，外层 spacer 保留完整滚动高度。
- 导出确定性的 viewport/window 计算，1000 节点 fixture 首屏最多渲染 10 行、10 个节点及 10 条关联边。
- 增加 roving tabindex 与 `ArrowUp`、`ArrowDown`、`Home`、`End` 导航；滚动目标进入 viewport 后再聚焦。
- Checkpoint 页面现在要求选择一个恢复点和一个已登记 DSH 实例，只生成不可变恢复计划预览。
- 恢复计划使用 checkpoint 固定的版本作为来源，并以 `create-target-session` 新建 DSH 分支；当前 DSH 分支和之后版本均保留，不直接重置或覆盖。
- 相同 checkpoint/target 组合会复用已生成的预览，不重复提交 Engine 请求。

## 验证

- GitGraph 1000 节点渲染上限、四个键盘导航目标、Checkpoint 预览去重及隔离 DSH 快进集成：3 文件 / 5 tests 通过。
- session-ui、Dashboard、Engine 定向 typecheck 通过。
- 全部测试只使用合成数据与临时 fixture；未读取或修改正式 DSH/Codex home。
