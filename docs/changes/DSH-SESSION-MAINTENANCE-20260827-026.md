# P26：CLI、Loopback API 与 Codex 插件入口

## 结果

- CLI 新增 `codex-target add|list` 以及 `continuation preview|create|status|recover`。
- Codex target 的 cwd 和 workspace roots 只在管理员 CLI 登记时解析为真实路径；普通 continuation 请求仍只接受逻辑会话、版本和 preset ID。
- loopback API 新增 preview、create、query 和 recover 四个 Bearer 保护路由，沿用现有同源与请求体上限门禁。
- local API client 增加对应的强类型方法，CLI、HTTP 与插件共用同一个 `ContinuationService` 作业和错误语义。
- 新增可校验的 Codex 插件源码，包含 Skill 与零平台文件访问的 stdio MCP server。
- MCP 提供 `continuation_preview`、`continuation_create`、`continuation_status` 和 `logical_session_open`；只读取 Engine 自己的连接文件并访问 `127.0.0.1`。
- 插件明确要求先预览预算、再由用户确认创建；`manual-review` 不会自动新建替代任务。

## 验证

- 官方 plugin validator：通过。
- `apps/engine/test/continuation-entries.test.ts`：1 个契约测试通过。
- 契约测试用真实 HTTP server 与独立 MCP 子进程证明：两种入口返回同一 continuation job ID；无效 preset 返回同一个业务错误码；`thread/start` 只调用一次。
- contracts、local client 与 app engine 定向 typecheck：通过。

## 配置边界

Codex 插件需要 Engine 正在运行，并通过 `DSH_SESSION_MAINTENANCE_STATE_ROOT` 读取当前连接信息；也可由受控启动器同时提供 loopback origin 与 token。连接地址若不是 `127.0.0.1` 会失败关闭。
