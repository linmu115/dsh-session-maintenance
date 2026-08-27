# P18：DSH 风格 Dashboard 基线

## 结果

- 新增独立 React/Vite Dashboard 和共享 `@linmu/dsh-session-ui`，后续版本树、事务与插件面板使用同一套组件和视觉变量。
- Dashboard 已提供粘性顶部栏/导航、概览指标、实例兼容状态、分页会话摘要、刷新、加载、空数据和离线状态。
- 首屏只并行请求 overview 与最多 25 个会话摘要；不会读取版本图、正文、diff 或事务详情。
- Markdown 使用 React 节点渲染、跳过原始 HTML，并把链接协议限制为 HTTP(S)、页内锚点和站内绝对路径。
- 前端只接受本次启动时注入的 loopback origin/token，读取后立即从全局对象删除；任何凭据、用户目录或 Maintenance runtime 都不进入源码常量和构建产物。
- `--dsm-*` 设计变量、浅色 surface、紧凑按钮、状态色、字体与窄窗口规则均为本项目独立实现。

## 第三方边界

- `dsh-management-kit@0.1.1` 和 Maintenance 内的 `0.1.5` 均缺少明确许可证与仓库声明。
- 本项目没有复制、vendoring、链接或再分发它们的源码/产物；证据和保守门禁记录在 `docs/third-party/dsh-management-kit-license-review.md`。
- production bundle 中没有 `dsh-management-kit` 标识。

## 精简验证

- Dashboard/session-ui：2 文件 / 3 tests 通过。
- Dashboard/session-ui 定向 typecheck 通过。
- Vite production build 通过：JS 约 270 kB（gzip 约 82 kB），CSS 约 7 kB（gzip 约 2 kB）。
- production bundle 扫描未发现测试 token、`D:\\AI`、用户目录或 `dsh-management-kit`。
