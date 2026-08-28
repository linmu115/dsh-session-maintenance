# Dashboard 浏览器授权修复

**日期：** 2026-08-27  
**范围：** 从 DSH / Plugin Manager 打开独立会话维护看板

## 表现

DSH 能成功向 Maintenance Engine 申请一次性看板入口，浏览器也能完成 `303` 跳转并取得 HttpOnly 会话 Cookie，但看板随后显示未授权。

## 原因

看板页面使用 `Referrer-Policy: no-referrer`，因此浏览器首次请求 `/v1/ui/session` 时不会发送 `Referer`；同源 `GET` 通常也不发送 `Origin`。旧授权判断却要求二者至少存在一个，导致合法浏览器请求被拒绝为 `403 UI_SESSION_FORBIDDEN`。已有测试用手工添加的 `Origin` 模拟浏览器，未覆盖真实请求头组合。

## 修复前

- 一次性 launch code 能兑换成功。
- Cookie 能写入。
- 携带 `Cookie + Sec-Fetch-Site: same-origin`、但不带 `Origin/Referer` 的真实看板启动请求返回 403。

## 修复后

- 无 `Origin` 时，要求浏览器提供 `Sec-Fetch-Site: same-origin`，并要求 HTTP `Host` 与 Engine 的精确 loopback origin 一致。
- 若请求带 `Origin`，仍要求它与 Engine origin 完全相等。
- 若请求带 `Referer`，仍校验其 origin；跨站 Fetch Metadata 继续拒绝。
- 保留 `HttpOnly + SameSite=Strict` Cookie、一次性短期 launch code 和后续 CSRF 校验，没有把 Engine token 暴露给浏览器。
- Engine 发布版本提升到 `0.1.1`。

## 位置

- `apps/engine/src/http/ui-session.ts`
- `apps/engine/test/ui-session.test.ts`
- `apps/engine/package.json`

## 验证

- 单元测试覆盖无 Referer 的真实浏览器启动头，以及跨站拒绝路径。
- Windows Node 22 上的便携性子进程门禁保留全部检查，仅把不合理的 5 秒进程时限放宽到 15 秒，避免慢 runner 把完整成功的审计误报为超时。
- 重新构建 Engine 与 Dashboard 发布产物后，在官方 DSH `web` profile 冷启动。
- 从 DSH 请求新的入口，确认 claim、Cookie、session bootstrap 和看板 API 全链路成功。
