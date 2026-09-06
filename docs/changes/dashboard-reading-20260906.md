# Maintenance 看板阅读与接入重整 · 2026-09-06

## 变更

主导航收敛为“会话 / 同步 / 恢复点 / 存储空间 / 设置”，默认打开会话。阅读入口只请求工作区目录与所选会话，不再依赖 overview、项目目录或运行实例在线状态。

会话按 Maintenance 工作区及其子工作区展示。搜索可匹配工作区或标题，匹配隐藏子项时自动展开。工作区目录在打开会话、切换导航、加载失败或重新读取时保持挂载，保留搜索、展开与选择状态。项目作为独立只读信息展示，没有与工作区混用。

阅读正文为静态 Markdown；没有模型输入、发送、重命名、改写、归档、删除或其他管理表单。Dashboard 只渲染查询返回的统一 readableText，不解析平台消息包装。非文字块保留在原始记录中。用户与助手正文优先，工具、推理、补充记录、版本来源和原始 JSON 默认折叠。SafeMarkdown 保留原来的 HTML、链接与图片安全边界；原始记录只输出经过 React 转义的文字。

恢复点页面解释保存的版本引用、保存时间与恢复影响。“最近删除 / 恢复已删除会话”作为默认可见的普通区块，历史事务仍放在高级区域。旧版保护记录只有通过只读来源能力核验后才能生成旧恢复预览，保留目标选择、风险、确认项与当前分支保留说明。存储空间解释已登记占用、受保护占用、可回收副本与“隔离并非立即释放”，保留预览确认、保护条件、隔离恢复和永久释放二次确认。

设置中的接入管理使用真实 listIntegrations / integrationAction 方法，提供重新发现、接入并检查、重新检查、修复与断开；结果以服务返回的状态、能力与问题为准。没有方法的旧引擎明确显示不可用，不做本地假成功。历史设置中的无效原生同步开关已隐藏，实例/映射只读展示，维护偏好保存不再发送历史同步字段。

同步页面使用 getWorkspaceSync / saveWorkspaceSync，保存带 revision 的工作区白名单，明确涵盖未来新会话。保存结果始终说明 Codex 原生回写尚未生效；没有任何路径因勾选复选框而绕过 nativeSyncSupported=false 的边界。导入与运行进度、历史同步计划放在本页折叠区域；诊断与适配器详情保留在设置高级区域。

布局采用浅色画布、低对比绿色、持续可见的工作区侧栏、舒适的正文字号与行距；窄屏保留目录并改为上下布局。新外观仅位于 dashboard.css，不影响其他 session-ui 消费者。正文渲染按需加载，避免增加目录入口加载量。

浏览器长时间停留后的认证失效不再只显示英文 Authentication required：DashboardClient 会提示从 DSH 会话维护设置重新打开完整看板。该转换只处理看板身份错误，不改变凭据有效期、认证规则或其他 API 错误；客户端的 3 项新增回归覆盖两种身份错误与普通失败保持原样。

最终浏览器核对后，为存储预览内容补齐内间距、按钮间距与自适应的五项统计排列；该样式只作用于看板存储面板。重建后已目视确认，同日完整回归为 655 项通过，详见综合验收报告。

## 验证

- `pnpm exec vitest run apps/dashboard/test packages/session-ui/test --maxWorkers=1`
- `pnpm --filter @linmu/dsh-session-maintenance-dashboard typecheck`
- `pnpm --filter @linmu/dsh-session-maintenance-dashboard build`

新增 happy-dom / React DOM 实际交互测试覆盖默认导航、独立于 overview、工作区与选择保留、Markdown正文、无管理表单、失败重试、取消后迟到响应、接入四种动作及失败/缺API、带版本号的同步名单保存及失败/缺能力、旧原生同步开关隐藏、恢复影响/预览，以及存储隔离确认。另有正文文字提取、补充记录默认折叠与原始HTML转义的模型/渲染测试。

当前 UI 回归为 12 个测试文件、37 项测试通过（其中 15 项 DOM 交互）。展示转换架构修复另已验证适配器 3 项、查询/API 4 项、共享契约 2 项；该专项 API 测试采用仓库已有的 15 秒超时设置。

## 本批恢复能力边界

恢复已删除会话调用现有 restoreCanonicalSession，只撤销删除并恢复目录可见性，不将正文回退到任意历史版本。入口位于恢复点页的普通区块，不需要展开高级设置；成功后刷新阅读页目录，失败保留条目并明确显示错误。最近删除列表与旧版保护记录独立加载，后者不可用不会隐藏撤销删除入口。

现有手动 createCheckpoint 只保存引用，不能完成当前 Canonical 历史版本的还原。因此本批没有新增“保存成功却不能还原”的手动创建按钮，没有把输入放回静态阅读页，也没有临时扩展历史还原后端。

已有保护记录使用 getCheckpointRestoreCapability 的只读结果判定是否适用旧预览，不根据名称或 ID 前缀猜测。只有所选记录的 supported=true 才能生成旧版恢复预览；缺 API、请求失败、返回 false、结果不对应当前选择或切换后的迟到结果均不会开放入口。页面显示服务返回的中文原因，并明确来源核验不代表目标可写：目标适配器能力仍由 createCheckpointRestorePlan 检查。删除前自动保护记录的撤销删除入口在上方“最近删除”。

本部分新增 4 项 DOM 行为测试：正常可发现的撤销删除入口及真实 API 调用/目录刷新、撤销失败保留条目、恢复来源缺失/不支持/失败关闭入口、切换记录后取消并忽略迟到能力结果。`pnpm exec vitest run apps/dashboard/test packages/session-ui/test --maxWorkers=1` 全部 37 项通过；Dashboard typecheck / build 通过。能力查询后端和 HTTP/client 由独立任务实现与验证，本部分只修改 Dashboard 与本报告。

## 展示转换的架构边界

DSH RC1 原生助手的 turn/step/message 包装属于平台知识，拆包装现位于 adapter-dsh-rc1 的纯只读 readRc1CanonicalEventText。适配器仅展开已证实的顶层消息，再提取已知文字块，不搜索 metadata、source 或嵌套 message。测试从真实 native-lifecycle-roundtrip 同形状的 payload 经 normalizeRc1Append 生成事件，并验证转换前后事件完全一致。

Engine 的会话查询按来源调用适配器，并为事件追加查询专用的 readableText；已经规范化为字符串的其他平台内容直接提供该字符串。查询保留 content、rawPayload、digest 和其它全部原字段，不存储展示结果、不迁移或改写来源。实际 HTTP/client 回归核对 native 正文可读，且数据库 event_json 在查询前后不变。

CanonicalDashboardEvent 与对应 schema 承载该可选字段，兼容旧响应；持久化 CanonicalEventV1 不接受 readableText。响应 schema 使用 safeExtend 保留原有事件 refinements。Dashboard 对缺少字段的旧引擎明确说明“未提供可读正文”，保留原始记录查看入口。UI测试只验证统一字段渲染与安全边界，不包含平台拆包装逻辑。

本部分验证命令：`pnpm exec vitest run apps/dashboard/test packages/session-ui/test packages/contracts/test/dashboard-readable-text.test.ts packages/adapter-dsh-rc1/test/readable-text.test.ts apps/engine/test/canonical-dashboard-api.test.ts --maxWorkers=1 --testTimeout=15000`；另通过 contracts / RC1 adapter 构建及 Engine / Dashboard typecheck。

测试与构建均在隔离工作树执行，只用合成 fixtures。未部署、未操作真实会话或 Codex/DSH 配置；未改变 Engine 治理和恢复协议。原生 Codex 回写仍未通过能力验证，本变更仅提供诚实的接入状态与范围配置界面。
