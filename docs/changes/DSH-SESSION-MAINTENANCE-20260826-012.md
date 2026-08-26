# P12：认证 Loopback API、持久化作业与类型化客户端

## 目标

为只读 Engine 提供仅绑定 `127.0.0.1` 的受限 HTTP/SSE 接口，把扫描作为可恢复作业执行，并提供验证所有响应的 TypeScript 客户端。

## 修改文件

- 作业迁移：`packages/session-store/src/migrations/002-job-events.ts`
- schema/database/index 与新版数据库测试调整：`packages/session-store/src/{schema,database,index}.ts`
- 作业存储与运行器：`apps/engine/src/jobs/{job-store,job-runner}.ts`
- HTTP 安全与路由：`apps/engine/src/http/{auth,body,routes,server,sse}.ts`
- Engine/CLI 导出与 `serve` 命令：`apps/engine/src/{engine,index,cli}.ts`
- 类型化客户端：`packages/local-api-client/`
- API、恢复和客户端测试：`apps/engine/test/{http-api,job-runner}.test.ts`、`packages/local-api-client/test/client.test.ts`
- 依赖锁：`pnpm-lock.yaml`

## 关键决策

- 服务拒绝任何非 `127.0.0.1` 绑定；除 health 外所有 `/v1/*` 路由要求随机 32 字节 bearer token。
- 浏览器提供 Origin 时必须精确等于当前 loopback origin；响应固定 `no-store`、`nosniff` 和限制性 CSP。
- 请求 JSON 最大 64 KiB，并通过 strict DTO schema 验证；HTTP 永远不能登记或接收平台 root。
- `connection.json` 使用 mode `0600`；Windows 以 `whoami.exe` 和 `icacls.exe` argv、`shell:false` 收紧 ACL。
- token 不写日志、不进入普通错误消息；客户端在抛错前再次执行 token 脱敏。
- 作业状态和事件写入 SQLite；sequence 单调递增。仅 scan 可自动恢复，中断的未知/非幂等类型标记 `RECOVERY_REQUIRED`。
- SSE 支持已有事件回放和 `Last-Event-ID`/`after` 续传。
- `MaintenanceClient` 使用同一 contracts schema 校验 sessions、graph、diff、plan、job 和 SSE event。
- apply/restore HTTP 端点存在但固定返回 `CAPABILITY_NOT_AVAILABLE`，没有平台写能力。

## 测试与结果

- 未认证 sessions 返回 401；恶意 Origin 返回 403；非 loopback bind 返回 `LOOPBACK_ONLY`。
- 超过 64 KiB 返回 413；包含 `root` 的 scan 请求因 strict schema 返回 400。
- 扫描 SSE 事件依次为 queued、running、progress、progress、completed，sequence 为 0–4。
- 中断 scan 只追加一次 requeue；未知中断类型失败并记录 `RECOVERY_REQUIRED`。
- 类型化客户端错误不会泄露 token canary。
- Windows ACL 命令被验证为参数数组，不拼接 shell 命令。
- 作业扫描前后 Codex fixture tree SHA-256 相同。
- `pnpm check`：8 个包 typecheck/build 通过，22 个测试文件、57 个测试通过。
- `git diff --check`：通过。

## 后续边界

- Phase 1 API 只提供只读查询、dry-run plan 和 scan job；没有平台 writer。
- Dashboard 和双向镜像属于后续阶段，不进入本提交。
