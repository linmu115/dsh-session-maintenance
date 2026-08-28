# Dashboard 浏览器 Fetch 调用修复

**日期：** 2026-08-28  
**范围：** Maintenance Dashboard 首屏数据加载

## 表现

从 DSH 打开看板后，页面能够完成一次性入口兑换并显示 Dashboard 外壳，但主区域显示“维护引擎暂时不可用”，具体错误为：

```text
Failed to execute 'fetch' on 'Window': Illegal invocation
```

## 原因

`DashboardClient` 把浏览器原生 `fetch` 保存为 `ApiClient` 的字段，后续通过 `this.fetchImpl(...)` 调用。Chromium 因此收到错误的 `this` 接收者（`ApiClient` 实例而不是正常的函数调用环境），在真正发送 `/v1/overview` 前就抛出 `Illegal invocation`。

此前的单元测试注入的是箭头函数；箭头函数忽略 `this`，所以没有暴露该浏览器专属错误。接口级验收也直接请求 Engine，没有执行 Dashboard 浏览器 bundle。

## 修复

- 在构造客户端时用箭头包装传入的 fetch 实现，确保后续作为对象字段调用时不会把 `ApiClient` 注入底层 fetch。
- 回归测试改用会检查接收者的 fetch 替身，同时覆盖 session bootstrap 与首个 overview 请求。
- Engine + Dashboard 发布版本提升为 `0.1.2`。

## 位置

- `packages/local-api-client/src/client.ts`
- `packages/local-api-client/test/client.test.ts`
- `apps/engine/package.json`

## 验收

- 客户端回归测试必须证明两次 fetch 都没有收到 `ApiClient` 接收者。
- 重新构建并部署 Dashboard 后，使用真实 Chrome 从一次性入口进入。
- 页面必须显示正常概览内容，控制台不得再出现 `Illegal invocation`。
