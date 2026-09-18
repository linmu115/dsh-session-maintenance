# 扩展数据与插件信息页排版修复

2026-09-18；私有 dashboard 版本由 0.1.2 调整为 0.1.3。Engine 与宿主版本、业务合同及发行兼容门禁不变。

## 问题与改动

新增插件信息页直接排在扩展目录前，缺少对应容器、字段和状态表样式；多个绑定动作也把目录推到下方。长实例身份、Vault 值以及浏览器默认 fieldset 的最小宽度构成内容溢出风险，但不能据截图断言整页实际溢出：主任务修复前测得 1088px 视口的 document width=scrollWidth=1088，仅窄导航按钮 clientWidth=52 / scrollWidth=59，截图底部为窄导航自身滚动。

- 扩展数据默认展示“数据目录”，通过“插件信息与接入”切换到提供方状态与操作。两边保持挂载，切换不丢弃未确认操作、输入或回执。
- 沿用现有 Surface、Button 与主题 tokens；补齐卡片内边距、章节间距、状态列表及响应式动作卡片。身份和值允许自然换行，grid/flex/fieldset 子项可收缩，窄屏状态项改为上下排列。
- 目录披露按钮有展开状态和收起文案；嵌套目录使用单列，避免视口较宽但卡片可用宽度不足时溢出。没有用全局隐藏横向滚动掩盖内容。
- 当前截图另暴露共享窄导航的既有问题：64px 导航中的长文字继承 nowrap。仅为导航按钮的 span 添加换行、可收缩尺寸与行高，不改变导航宽度或其他按钮。

保留原 API、目标 owner、expectedRevision、operationId 幂等、提交/轮询/错误重试、离线禁用和数据写入语义。目录默认显示的行为变化仅影响页面组织。

## 验证与产物

- dashboard TypeScript 无输出检查通过。
- 业务页与扩展页 2 文件 5 tests 通过；新增用例覆盖默认目录、视图切换保留未确认动作及原请求身份。
- 扩展归属目录及 session-ui 3 文件 8 tests 通过；两批共 5 文件 13 tests。
- Vite 生产构建通过，输出 `apps/dashboard/dist/`；已确认该目录是此源码工作树中的真实目录，不是部署目录链接。
- `dist/build-hashes.json` 保存本次 HTML 与全部 assets 的 SHA-256/字节数。入口 `index.html` 为 `d0b0c1cd853a12024f04220d115cdcffb15b456c3dae45cc8faf72c6d7632a7d`。

本任务没有启动或停止真实实例、部署构件、绑定 Vault、读取/修改用户历史或调用模型。真实 Edge/BrowserUse 鉴权、桌面及窄屏 scrollWidth、暗色主题和控件视觉核验由主任务在独立部署记录中补充；DOM 单元测试不证明实际布局无溢出。

## 主任务部署与浏览器补验

2026-09-18 主任务已将 Dashboard 0.1.3 热更新到当前 Engine release 的 dashboard 目录。更新前完整备份原静态目录，先添加新哈希资源再切换入口，保留旧资源；HTTP 返回字节与构建哈希一致。Engine 入口哈希未变，未重启 DSH 或 Engine，当前 run 与 boot 保持不变。

Browser Use 已刷新真实维护页，检查“数据目录”和“插件信息与接入”的切换与卡片视觉。宽窗口 clientWidth/scrollWidth 均为 1103，窄窗口均为 640，所检查元素无横向溢出，浏览器无 error 日志。已还原临时窗口尺寸；本轮未验证暗色主题，未执行绑定操作。

Edge 访问问题另已确认为新浏览器无登录 Cookie：裸地址 401，完整 Launcher 登录入口 303 并签发 Cookie，带 Cookie 首页 200。主任务通过新 Open-DSH 命令执行了 Edge 打开请求；Edge 自动化连接不可用，未声称完成 Edge 内视觉验收。

本机部署与验收回执分别位于 `D:/AI/DeepSeekHarness-Plugin/artifacts/single-bridge-20260918/dashboard-ui-hotfix-installed.json` 与 `dashboard-ui-hotfix-acceptance.json`，不含认证令牌或会话正文。
