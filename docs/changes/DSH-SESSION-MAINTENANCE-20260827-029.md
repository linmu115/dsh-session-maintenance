# P17：类型化操作 API 与持久作业

## 结果

- 为会话详情、按需版本正文、事务列表/详情、Checkpoint、适配器诊断、总览与设置建立了统一 DTO 和严格响应 Schema。
- Engine 只通过既有 P14–P16 `WriteService` 暴露写能力；HTTP 层不直接接触 DSH 文件或重新实现事务规则。
- `MaintenanceClient` 已覆盖上述查询与操作，并支持计划应用、受控恢复确认、恢复作业和 Checkpoint 操作。
- 计划应用与事务恢复进入持久 JobStore；中断的 apply 可以依赖事务幂等边界恢复，restore token 不落盘，中断后必须重新取得一次性确认。
- 分页上限统一为 100；版本正文按需读取且限制为 4 MiB；路径标识和未知请求字段失败关闭。
- SSE 使用持久 sequence 作为事件 ID，客户端校验 ID/正文一致并可从 `after` 继续读取。
- Engine 设置继续保存在私有状态目录，仅登记 instance/workspace ID，不接受任意路径。

## 安全边界

- 本阶段只使用合成 fixture 和临时状态目录，没有读写正式 DSH/Codex home。
- 恢复确认 token 只存在于当前调用链；JobStore 仅保存 transaction ID。
- API 仍只绑定 loopback、要求 bearer token，并拒绝非本机 Origin。

## 精简验证

- `phase2-api`、HTTP、JobRunner、local client、config 和 session-store：8 文件 / 15 tests 通过。
- contracts、session-store、local-api-client、engine 定向 typecheck 通过。
- 覆盖 client/server DTO 对齐、版本懒加载、严格字段/路径拒绝、SSE 续读、apply 重放和 restore token 不落盘。
