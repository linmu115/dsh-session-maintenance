# Codex 原生同步第二阶段可行性核查

核查日期：2026-09-06。实测内核：桌面配套 Codex 0.153.4。范围：当前二进制生成的官方协议、官方在线文档、隔离合成会话；未实施生产同步。

## 结论

**在本次检查的公开 app-server 协议中，没有找到“把 DSH 已完成的用户与助手回答作为完整原生轮次追加到指定原 Codex 会话 ID”的受支持入口。** 这不是证明所有内部实现均不可能；是当前版本、当前公开接口与已运行探针支持的边界。

`thread/inject_items` 与 `thread/resume.history` 都不能达成用户目标。后者已实测：原会话加载时拒绝；原会话未加载时忽略所给原 ID，创建新 ID，而且传入的用户/助手文本仍只进入模型上下文，未成为可读取的原生消息。

按原 ID `thread/resume` 后执行 `turn/start` 可以让 Codex 自己创建完整原生轮次：两种历史模式均由 1 轮增加到 2 轮，发出 turn/item 通知，重启恢复后保持原 ID 和两轮历史。因此，可维护的公开协议方向是**让 DSH 中的交互驱动原 Codex 会话执行**。它不能直接搬运已经由 DSH 独立生成的既有答案；是否符合产品所需的执行归属，需要明确决定。

上述通过项是协议和持久化验证，**未验收真实桌面页面显示、引用回答、桌面继续真实对话**。不能把本报告写成“原生双向同步已支持”。

## 能力矩阵

| 通道 | 性质与证据 | 原 ID | 已完成回答成为原生轮次 | 判断 |
| --- | --- | --- | --- | --- |
| `thread/resume(threadId)` + `turn/start` | 官方公开的正常续聊路径；本次两种历史模式均实测 | 保持 | Codex 本次实际执行产生的新轮次可见；不接收任意助手答案作为导入参数 | 可作为 DSH 驱动 Codex 执行的基础；桌面验收待做 |
| `thread/inject_items` | 本地协议说 model-visible history；前阶段两种历史模式实测 | 保持 | 否；模型后续输入能看到，原生历史没有新消息/轮次 | 不满足完整同步 |
| `thread/resume.history`，原会话已加载 | 字段明确 `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE`；本次实测 | 不执行 | 接口拒绝 `cannot resume ... with history while it is already running` | 不可用作追加 |
| `thread/resume.history`，原会话未加载 | 同上；ResponseItem 数组，没有完整 Turn 导入契约 | 改成新 ID，legacy 模式 | 初始 0 轮；后续模型输入包含传入内容，后续原生历史仍不含传入内容 | 同时不满足 ID 与原生可见性 |
| `thread/resume.path` | `[UNSTABLE]`；读取已有 rollout；本次只读取由 Codex 自己生成的合成文件 | 文件原 ID 保持 | 只加载文件已有轮次，没有“追加完成轮次”输入 | 不是导入写接口；要手写文件则进入兼容层 |
| `thread/fork` | 官方公开复制历史；本次实测 | 新 ID | 复制现有轮次 | 不满足原 ID 约束 |
| `externalAgentConfig/import` 的 `SESSIONS` | 官方代理迁移入口；schema 的 SessionMigration 只有 cwd/path/title | 没有指定目标原 Codex ID 的公开参数 | 公开资料未承诺向既有 Codex 轮次追加 | 可研究迁移流程，不能承诺同 ID 双向同步；本次未伪造外部会话文件 |
| `externalAgentConfig/import/recordHistory` | 参数是 providerId 与逐类成功/失败结果 | 无目标会话参数 | 记录导入任务结果，非聊天消息 | 名称中的 history 不是聊天历史写入 |
| `project/import` / metadata 更新 | 项目、roots、线程 ID 归属/元数据 | 仅管理引用/归属 | 无轮次消息载荷 | 不能导入聊天答案 |
| `thread/realtime/*` / initialItems | 协议明确实验性；initialItems 仅 Realtime V3 启动上下文 | 不构成原普通轮次导入承诺 | 无公开的普通已完成轮次导入契约 | 不以语音通道绕接普通历史 |
| `thread/rollback` / `thread/revert` | 删除尾部或保留指定前缀 | 保持 | 只能移除已有历史 | 不是通用替换/追加 API |
| 直接写 rollout / 数据库、修改内核 | 非公开历史写接口，需要版本兼容、索引、缓存与并发协议 | 有潜在可能，未验证 | 不能据本次结果确认 | 本次未做，需独立方案后才可开始合成验证 |

正式性应分层表述：公开文档存在的普通接口、需 experimentalApi 的接口/字段、明确 UNSTABLE/Cloud-only 的字段，不能混成一项“官方支持”。官方网页同时把 app-server 命令与 WebSocket 传输标为实验且不支持生产负载；这与普通 API surface 的分层是不同维度，不应宣称生产 SLA。

## 本次隔离验证

新探针 `probe-codex-resume-channels.mjs` 复用了前次仅监听 127.0.0.1 的 Responses 假模型。每次启动新临时 CODEX_HOME、临时用户目录和工作区，环境变量采用少量白名单，未继承 auth/API key。配置指定无需 OpenAI 认证的本机 provider，未调用外部模型。所有 threadId 均由隔离 app-server 新建；没有把真实会话 ID、真实 rollout 或数据库作为请求目标。

分页与 legacy 两次运行均确认：

1. 新建并完成一轮原生合成对话。
2. 对已加载原 ID 传 history，接口拒绝。
3. 重启后用原 ID + history，返回不同的新 ID、legacy 历史模式，初始 0 轮。
4. 新 ID 发起下一轮，假模型收到传入的用户和助手文本；legacy 官方历史只包含本次实际执行的一轮，不含传入历史文本。
5. 原 ID 普通恢复并续聊，原生历史 1 → 2 轮，具有 `turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed` 通知。
6. 再次重启按由 Codex 原生生成的 rollout 路径恢复，原 ID 和 2 轮历史保留。fork 得到新 ID。

分页探针在读取 history 恢复所产生的 legacy 新线程时，`thread/items/list` 返回 not supported yet；这是跨模式读取限制，不据该错误推断内容消失。另一次全 legacy 运行已用正确的 `thread/read(includeTurns)` 验证传入历史在后续轮次后仍不可见。

日志显示 Codex 会发现临时目录上层用户目录中的项目配置位置并提示未信任；因此输出中的隔离标志是目标/配置断言，不能当作全进程文件访问审计。初始化返回的 CODEX_HOME 与临时目录严格一致；没有真实认证或真实会话写入。未运行网络/文件系统跟踪审计。

## 实验开关的本地实测

另一个零模型调用探针使用 `experimentalApi: false`：

| 请求/字段 | 0.153.4 返回 | 可得结论 |
| --- | --- | --- |
| `thread/resume.history` | requires experimentalApi capability | 明确受实验开关保护 |
| `thread/resume.path` | requires experimentalApi capability | 明确受实验开关保护 |
| `thread/realtime/start` | requires experimentalApi capability | 明确受实验开关保护 |
| `thread/inject_items` 空数组 | items must not be empty | 请求通过实验门禁后进入参数校验；不代表本次空数组写入成功 |
| `thread/resume.excludeTurns` | no rollout found | 未遇实验开关拒绝；新空线程未物化 |
| `thread/turns/list` | thread is not materialized yet | 未遇实验开关拒绝；新空线程未物化 |
| `thread/items/list` | not supported yet | 此条件下接口不可用；不扩大为所有分页线程都不可用 |

该探针普通 `thread/start` 默认创建 paginated 会话，未发起任何模型请求。线上文档对部分分页字段/方法的实验性描述与本地门禁表现不完全一致，实施应优先按实际二进制生成 schema 并运行能力探针，不把网页或方法命名当作同版本保证。结果见 `native-stable-api-gates-probe.json`，脚本见 `probe-codex-api-gates.mjs`。

## 同步加载与工作区白名单边界

当前完整请求表中没有发现通用 `thread/reload`、完整 `turn/import`、替换历史后广播桌面缓存失效的公共接口。`thread/read` 是读取，`thread/resume` 是加载/重连，不能据此保证另外一个已运行的桌面 app-server 自动刷新。本次验证的是单独进程退出再启动；没有验证两个进程共享同一 CODEX_HOME 时的一致性。

同一工作区的未来新会话可由接入层发现后纳入授权判定，但这是 Maintenance 必须实现的范围策略，不能说 Codex API 已经自带工作区写白名单。`thread/list.cwd` 是筛选参数，projectId/metadata 是归属字段，`turn/start.cwd` 和 runtimeWorkspaceRoots 是执行配置，均不能等同防止任意 threadId 写入的授权令牌。

范围策略应使用精确规范化工作区根、可信的会话归属映射和接入实例身份；入队与提交时均核对，任何不明确匹配拒绝提交。路径必须考虑 Windows 大小写、尾分隔符、符号链接/junction、工作树与多根目录；不能用简单字符串前缀授权。会话移动/项目改绑与撤销授权需要明确处理，未来会话通过同一规则自动纳入。新建于 DSH 的未来会话若需要 Codex 原生身份，应由官方 `thread/start` 分配原生 ID，再保存映射，不自行构造 ID。

这部分是设计要求，尚未作为生产白名单实现和验收。

## 下一步实际选项

1. **公开执行通道：DSH 作为交互入口，Codex 作为原会话执行方。** 优先保持同一 app-server 所有者，串行发送 `turn/start` 并读取原生事件；避免两个独立运行实例同时写同一会话。后续须隔离桌面验收显示、引用、续聊、关闭重开，再做幂等和冲突检查。这满足未来交互的原生轮次方向，不解决先前由 DSH 独立生成的答案搬运。
2. **如果必须保留 DSH 已完成答案：先设计专门兼容层，再合成验证。** 一个值得评估的候选是受控的本机答案重放 provider：`turn/start` 提交原用户文本，provider 返回已保存助手文本，由 Codex 自己生成持久化轮次。它不要求模型重新生成答案，也不直接写原生文件，但不是官方“导入完整轮次”功能。本次静态假模型只证明普通答案事件可以形成轮次，没有验证这种导入语义、原 provider/模型恢复、历史时间、工具调用、附件、计费/元数据、桌面引用与并发；不能现在启用。应先出具体方案并批准有限探查范围。
3. **若重放不能保真，再评估版本锁定的原生文件兼容层。** 必须先解决 rollout 事件与模型上下文双重表示、分页索引、原子提交、会话静止、桌面缓存、备份回滚及升级验收。禁止只往 JSONL 追加 ResponseItem 或只改数据库就宣称成功。本次没有开始原生格式写入。

接入向导/工作区白名单可以独立完善，但完整原生同步应保持“未通过能力验证”，直到所选路线完成客户端验收。

## 证据

本次关键 JSON 结果与精简协议快照已随报告保存在 [evidence/codex-0.153.4](evidence/codex-0.153.4)。这些文件包含合成会话 ID、临时路径及实际返回值，未包含真实会话正文或认证信息。以下探针源码和完整 schema 保留在本机施工目录 `C:/Users/19717/OneDrive/文档/ChatGPT/dsh/.artifacts/dashboard-sync-design-20260906`；它们是绑定当时二进制的取证脚本，不作为可移植产品工具发布。

- `resume-channels-probe.json`：分页原会话验证，含原生历史和请求结果。
- `resume-channels-legacy-probe.json`：legacy 原会话与 history 新会话的正确历史读取证据。
- `probe-codex-resume-channels.mjs`：可复查 throwaway 探针。
- `native-stable-api-gates-probe.json` 与 `probe-codex-api-gates.mjs`：无实验开关、零模型调用的门禁核查。
- `native-write-channel-schema-extract.json`：59 个相关方法、15 个相关定义的精简快照；原始完整 schema 在同目录 `codex-0.153.4-schema/ClientRequest.json`。
- 前阶段 `native-history-probe.json`、`native-history-legacy-probe.json`：inject_items 不产生原生历史的证据。
- [OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)：普通 resume/turn 工作流、experimentalApi、传输成熟度和外部代理导入 API。
- [OpenAI 代理迁移官方文档](https://learn.chatgpt.com/docs/import)：导入与自动更新的用户流程，未承诺自定义 DSH 追加到既有 Codex ID。

没有修改正式 Engine、插件、Launcher、新 Maintenance 工作树、真实 Codex 会话/数据库或真实模型设置，没有部署。
