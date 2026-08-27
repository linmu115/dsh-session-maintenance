# Windows 本地化账户连接文件 ACL 修正

**日期：** 2026-08-27  
**范围：** Engine loopback connection descriptor

## 发现

正式 Engine 首次启动时，Windows `whoami.exe` 返回的中文计算机名被 Node 子进程文本解码破坏，导致 `icacls` 无法识别 `机器名\用户`。服务器已经监听后才执行 ACL，因此原实现还会留下“命令报告失败、端口仍在监听”的半启动进程。

## 修正

- 改用 `whoami /user /fo csv /nh`，只提取 ASCII Windows SID。
- `icacls` 使用 `*SID:(F)` 设置当前用户独占访问，不再依赖本地化机器名或代码页。
- ACL 或 connection descriptor 写入失败时，立即关闭刚打开的 loopback server，并移除含短期 capability 的 descriptor。
- 新增乱码账户名样例，证明 SID 提取与 ACL 参数稳定。

## 验证

- `apps/engine/test/http-api.test.ts` 与 `ui-session.test.ts`：4 项通过。
- Engine package typecheck 通过。
- `git diff --check` 通过。

正式 DSH profile 仍未修改；失败的 Engine 预启动进程已停止。
