# P17/P18 纠错：Dashboard 浏览器认证边界

## 原问题

P18 初版让页面 JavaScript 从 `window.__DSH_SESSION_MAINTENANCE__` 读取 Engine bearer token，再交给通用 `MaintenanceClient`。即使 token 不在静态 bundle，这仍违反了既定边界：浏览器不应读取长期 Engine capability，也不应拥有 DSH gateway token。

## 修复后

- 受信 CLI/DSH host 使用 Engine bearer 身份请求一次性 launch code；launch code 60 秒过期、只能兑换一次且重定向固定为 `/dashboard/`。
- `/ui/claim` 只设置 15 分钟 `HttpOnly; SameSite=Strict; Path=/` UI session cookie，不把 Engine capability 返回给页面。
- 页面通过 cookie 引导端点取得该 UI session 的 CSRF，CSRF 只保存在 client 实例闭包，不写入 URL、全局变量、local/session storage 或文件。
- 后续所有 Dashboard API/SSE 请求必须同时拥有 UI cookie、exact loopback Origin（或同源导航的 Fetch Metadata + Referer）和匹配的 `x-dsh-csrf`。
- `POST /v1/ui/launch-code` 只接受 Engine bearer，Dashboard cookie 无法再次签发 launch code。
- 通用 typed client 已拆分 bearer transport 与 cookie transport；Vite tree-shaking 后 Dashboard bundle 不含 `Bearer ` 分支或 launch-code API。
- 删除 `runtime.ts` 和 `window.__DSH_SESSION_MAINTENANCE__` 数据通道。

## 验证

- UI auth、HTTP、P17 API、local client、Dashboard：6 文件 / 10 tests 通过。
- 覆盖 launch code 一次性/过期、固定重定向、HttpOnly/SameSite、恶意 Origin、缺失/错误 CSRF、未知 redirect 字段拒绝，以及 UI session 响应不含 Engine token。
- contracts、local-api-client、engine、Dashboard typecheck 通过；Dashboard production build 通过。
- production JS 扫描确认没有 `Bearer `、`/v1/ui/launch-code`、旧全局变量、测试 token、用户路径或 `dsh-management-kit`。
