# P21：官方 DSH 会话维护入口插件

## 结果

- 新增独立 `dsh-session-maintenance@0.1.0` 包，peer contract 精确锁定官方 DSH `0.1.1-rc.2`、Cordis `4.0.1` 与 client runtime `0.1.1-rc.2`。
- 固化 `sessions.list`、会话行和标题节点的 rc.2 合成契约与 fingerprint。契约漂移时客户端仅停用菜单/面板并报告 `UI_CONTRACT_INCOMPATIBLE`，不会按标题猜测重复会话身份。
- 会话右键入口包含看板、扫描、安全同步计划、Codex 比较、版本图、Checkpoint、解除映射候选、归档候选和删除候选。删除及需要复核的操作只进入计划/看板，不从菜单直接写平台。
- 新增轻量参数/操作面板；只编辑实例 ID、工作区映射 ID 与同步策略，只显示最近一次操作反馈和 plan/job ID。根目录登记继续由可信 CLI/安装器负责。
- Dashboard launch code 可绑定一个安全的 `logicalSessionId`。claim 仍固定 303 到 `/dashboard/`，浏览器仍只取得 HttpOnly UI session、CSRF 和可选逻辑会话 ID，不取得 Engine capability。
- Engine 新增 DSH `{instanceId, sessionId}` 到逻辑会话的窄解析 DTO，host proxy 据此创建计划与选中会话 deep link。
- `dsh-better-sidebar` 仅作可选入口；插件的代理、右键菜单与独立看板不依赖它。
- P15 Core gateway 现已真正挂到官方 DSH host：插件只暴露一个 HMAC 事务作用域的 loopback Core endpoint；独立 Engine 使用同一个 `DshWriteAdapter`、`TransactionExecutor` 和恢复状态机经远程 gateway 写入，不再停留在“菜单能生成计划、Engine 仍只读”的半连接状态。
- Engine 只有在可信启动参数显式登记 `instanceId=http://127.0.0.1:port` 时才创建 writable composition；默认 composition 继续保持只读。计划会同时锁定 rc.2 read contract 与 `dsh-write-core` contract。

## Engine 连接与安全边界

- Cordis 配置只保存无敏感的 `connectionId` 与 DSH/profile ID，不保存 origin、token 或本机路径。
- 可信安装器通过 host-only 环境登记 ACL 保护的 `connection.json`；浏览器/client schema 不知道描述符路径。
- host provider 按文件 mtime 重新读取 loopback v1 descriptor，覆盖 Engine 重启后的端口和 capability 轮换。
- Core gateway 使用同一 ACL descriptor 中的每次启动随机 capability 作为 host-only HMAC secret；Engine 按请求重新读取 descriptor，DSH host 在 capability 轮换时替换 token service。scope 绑定 transaction/plan/instance/session，nonce 单次使用，重放和 scope 漂移都会拒绝。
- proxy 只允许固定操作，限制请求 16 KiB、响应 1 MiB，拒绝未知字段和路径形 ID；不会启动、停止、补丁或卸载 Engine、DSH、EAC/桌面壳。
- Core endpoint 限制 64 MiB 请求/响应、仅接受固定操作，并只返回稳定错误码；service surface 或 Core host materialization 漂移时在任何 mutation 前 fail closed。
- 生产客户端包中没有 bearer、connection descriptor、token 或任意文件系统读取逻辑。

## 兼容与许可决定

- `dsh-management-kit` 的本机副本没有 LICENSE/COPYING/NOTICE，也没有 package license 字段，因此本任务没有复制或再分发其代码；入口视觉独立实现。
- 本任务没有安装到正式 profile，也没有读取或改写正式 DSH/Codex home。
- `pnpm pack` 已确认插件自身只包含 host/client/声明/patch/文档；内部 Core/gateway 包的自包含聚合由 P22 可复现打包完成，P21 不把 `workspace:*` 源码路径伪装成可迁移产物。

## 验证

- 全工作区 typecheck 通过。
- P21 Core transport/host/proxy/contract/menu/panel 与受影响 API/事务测试均固定 `--maxWorkers=1` 通过；覆盖真实远程 mutation+restore、有效 HMAC、重放/scope 漂移拒绝、service/materialization drift 零写入、Engine token/端口轮换和两个 host endpoint 的 unload cleanup。
- 全工作区 typecheck 与 build 通过。Windows 门禁固定 `--maxWorkers=1 --testTimeout=15000` 后，串行全工作区回归 58 files / 127 tests 全部通过；加长单测上限用于吸收 SQLite WAL/文件扫描的整套资源竞争，不改变任何业务断言。
- token/端口轮换、路径形 ID、Engine 离线、一次性 Dashboard 会话上下文和 DSH session resolution 均有聚焦测试。
- 插件 build 与 `pnpm pack` 通过；tgz 包含 host、client、声明、patch、README 和 MIT License，peer 版本与 rc.2 锁一致。
- `git diff --check` 通过。
